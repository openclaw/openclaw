using System.Text.Json;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Polls channels.status every 45 s and caches the result in IChannelStore.
/// </summary>
internal sealed class ChannelsStatusPollingHostedService : IHostedService
{
    // Tunables
    private const int PollIntervalMs = 45_000;
    private const int RpcTimeoutMs   = 12_000;
    private const int ProbeTimeoutMs =  8_000;

    private readonly IGatewayRpcChannel _rpc;
    private readonly IChannelStore _store;
    private readonly GatewayConnection _connection;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<ChannelsStatusPollingHostedService> _logger;

    private CancellationTokenSource? _cts;
    private Task? _loopTask;

    public ChannelsStatusPollingHostedService(
        IGatewayRpcChannel rpc,
        IChannelStore store,
        GatewayConnection connection,
        TimeProvider timeProvider,
        ILogger<ChannelsStatusPollingHostedService> logger)
    {
        _rpc        = rpc;
        _store      = store;
        _connection = connection;
        _timeProvider = timeProvider;
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
        var firstPoll = true;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (_connection.State == GatewayConnectionState.Connected)
                {
                    // First poll uses probe=true to force a fresh status check from the gateway.
                    await PollOnceAsync(probe: firstPoll, ct);
                    firstPoll = false;
                }

                await Task.Delay(PollIntervalMs, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (GatewayResponseException ex) when (ex.Message.Contains("missing scope"))
            {
                // Scope not granted by this token — not a transient error, no point retrying fast.
                _logger.LogDebug("channels.status: scope not available ({Msg})", ex.Message);
                _store.SetError("No channel configured");
                try { await Task.Delay(60_000, ct); }
                catch (OperationCanceledException) { return; }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("channels.status poll error: {Message}", ex.Message);
                _store.SetError(ex.Message);

                // Back off briefly on unexpected errors before retrying.
                try { await Task.Delay(5_000, ct); }
                catch (OperationCanceledException) { return; }
            }
        }
    }

    private async Task PollOnceAsync(bool probe, CancellationToken ct)
    {
        var parameters = new Dictionary<string, object?>
        {
            ["probe"]     = probe,
            ["timeoutMs"] = ProbeTimeoutMs,
        };

        var data = await _rpc.RequestRawAsync("channels.status", parameters, RpcTimeoutMs, ct);

        // Clone so the element outlives the JsonDocument that created it.
        JsonElement root;
        using (var doc = JsonDocument.Parse(data))
            root = doc.RootElement.Clone();

        _store.UpdateSnapshot(root, _timeProvider.GetUtcNow());
        _logger.LogDebug("channels.status refreshed probe={Probe}", probe);
    }
}
