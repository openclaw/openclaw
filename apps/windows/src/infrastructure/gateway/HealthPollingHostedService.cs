using System.Text.Json;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Health;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Polls the gateway health endpoint every 60 s and writes results into IHealthStore.
/// </summary>
internal sealed class HealthPollingHostedService : IHostedService, IDisposable
{
    // Tunables
    private const int PollIntervalMs        = 60_000;
    private const int InitialPollIntervalMs =  3_000;  // fast retry until first snapshot arrives
    private const int RpcTimeoutMs          = 15_000;
    private const int BackoffOnErrorMs      =  5_000;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly IGatewayRpcChannel _rpc;
    private readonly IHealthStore       _store;
    private readonly GatewayConnection  _connection;
    private readonly ILogger<HealthPollingHostedService> _logger;

    private CancellationTokenSource? _cts;
    private Task? _loopTask;

    public HealthPollingHostedService(
        IGatewayRpcChannel rpc,
        IHealthStore store,
        GatewayConnection connection,
        ILogger<HealthPollingHostedService> logger)
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

    public void Dispose() => _cts?.Dispose();

    private async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (_connection.State == GatewayConnectionState.Connected)
                    await RefreshAsync(ct);

                // Use a short retry interval until the first snapshot arrives so health
                // updates within seconds of the gateway connecting, not after 60 s.
                var delay = _store.Snapshot is null ? InitialPollIntervalMs : PollIntervalMs;
                await Task.Delay(delay, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("health poll error: {Message}", ex.Message);
                try { await Task.Delay(BackoffOnErrorMs, ct); }
                catch (OperationCanceledException) { return; }
            }
        }
    }

    private async Task RefreshAsync(CancellationToken ct)
    {
        if (_store.IsRefreshing) return;
        _store.SetRefreshing(true);

        var previousError = _store.LastError;
        try
        {
            var data = await _rpc.RequestRawAsync("health", null, RpcTimeoutMs, ct);
            var snap = DecodeHealthSnapshot(data);
            if (snap is not null)
            {
                _store.Apply(snap);
                if (previousError is not null)
                    _logger.LogInformation("health refresh recovered");
            }
            else
            {
                _store.SetError("health output not JSON");
                _logger.LogWarning("health refresh failed: output not JSON");
            }
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            var desc = ex.Message;
            _store.SetError(desc);
            if (previousError != desc)
                _logger.LogError("health refresh failed: {Message}", desc);
        }
    }

    // Tolerant decoder
    // Tries direct parse first; falls back to stripping stray log lines before/after the JSON blob.
    private static HealthSnapshot? DecodeHealthSnapshot(byte[] data)
    {
        try { return JsonSerializer.Deserialize<HealthSnapshot>(data, JsonOpts); }
        catch { }

        var text = System.Text.Encoding.UTF8.GetString(data);
        var first = text.IndexOf('{');
        var last  = text.LastIndexOf('}');
        if (first < 0 || last < first) return null;

        try { return JsonSerializer.Deserialize<HealthSnapshot>(text[first..(last + 1)], JsonOpts); }
        catch { return null; }
    }
}
