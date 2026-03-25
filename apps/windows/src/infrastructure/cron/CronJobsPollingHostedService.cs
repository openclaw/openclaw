using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Infrastructure.Cron;

/// <summary>
/// Polls cron.status + cron.list every 30 s and writes results into ICronJobsStore.
/// Also services event-triggered refresh signals (set by HandleCronEvent).
/// </summary>
internal sealed class CronJobsPollingHostedService : IHostedService
{
    // Tunables
    private const int PollIntervalMs    = 30_000;
    private const int CheckIntervalMs   =    500;  // inner loop cadence for signal detection
    private const int RunsDefaultLimit  =    200;

    private readonly IGatewayRpcChannel _rpc;
    private readonly ICronJobsStore _store;
    private readonly GatewayConnection _connection;
    private readonly ILogger<CronJobsPollingHostedService> _logger;

    private CancellationTokenSource? _cts;
    private Task? _loopTask;

    public CronJobsPollingHostedService(
        IGatewayRpcChannel rpc,
        ICronJobsStore store,
        GatewayConnection connection,
        ILogger<CronJobsPollingHostedService> logger)
    {
        _rpc        = rpc;
        _store      = store;
        _connection = connection;
        _logger     = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _cts      = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _loopTask = Task.Run(() => LoopAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _cts?.Cancel();
        if (_loopTask is not null)
        {
            try { await _loopTask.WaitAsync(ct); }
            catch (OperationCanceledException) { }
        }
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        var nextScheduledPollAt = DateTimeOffset.UtcNow;  // poll immediately on start

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(CheckIntervalMs, ct);

                if (_connection.State != GatewayConnectionState.Connected)
                {
                    // Not connected — reset the schedule so we poll as soon as we reconnect.
                    nextScheduledPollAt = DateTimeOffset.UtcNow;
                    continue;
                }

                var now = DateTimeOffset.UtcNow;

                // Event-triggered refresh in macOS).
                var signaled = _store.ConsumeRefreshSignal();
                if (signaled || now >= nextScheduledPollAt)
                {
                    await RefreshJobsAsync(ct);
                    nextScheduledPollAt = DateTimeOffset.UtcNow.AddMilliseconds(PollIntervalMs);
                }

                // Runs refresh triggered by a "finished" event on the selected job.
                var (runsPending, runsJobId) = _store.ConsumeRunsRefreshSignal();
                if (runsPending && runsJobId is not null)
                    await RefreshRunsAsync(runsJobId, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (GatewayResponseException ex) when (ex.Message.Contains("missing scope"))
            {
                _logger.LogDebug("cron: scope not available ({Msg})", ex.Message);
                _store.SetError("Cron not available");
                try { await Task.Delay(60_000, ct); }
                catch (OperationCanceledException) { return; }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("cron poll error: {Message}", ex.Message);
                _store.SetError(ex.Message);

                try { await Task.Delay(5_000, ct); }
                catch (OperationCanceledException) { return; }
            }
        }
    }

    private async Task RefreshJobsAsync(CancellationToken ct)
    {
        if (_store.IsLoadingJobs) return;

        _store.SetJobsLoading(true);
        try
        {
            GatewayCronSchedulerStatus? status = null;
            try { status = await _rpc.CronStatusAsync(ct); }
            catch (Exception ex) { _logger.LogDebug("cron.status failed: {Message}", ex.Message); }

            var jobs = await _rpc.CronListAsync(includeDisabled: true, ct);
            _store.ApplyJobsSnapshot(jobs, status);
            _logger.LogDebug("cron refreshed jobs={Count}", jobs.Count);
        }
        finally
        {
            _store.SetJobsLoading(false);
        }
    }

    private async Task RefreshRunsAsync(string jobId, CancellationToken ct)
    {
        if (_store.IsLoadingRuns) return;

        _store.SetRunsLoading(true);
        try
        {
            var entries = await _rpc.CronRunsAsync(jobId, limit: RunsDefaultLimit, ct);
            _store.ApplyRunsSnapshot(entries);
            _logger.LogDebug("cron refreshed runs jobId={JobId} count={Count}", jobId, entries.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("cron.runs failed jobId={JobId}: {Message}", jobId, ex.Message);
        }
        finally
        {
            _store.SetRunsLoading(false);
        }
    }
}
