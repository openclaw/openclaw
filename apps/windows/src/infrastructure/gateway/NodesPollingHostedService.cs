using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Nodes;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Polls node.list every 30 s and writes results into INodesStore.
/// </summary>
internal sealed class NodesPollingHostedService : IHostedService, IDisposable
{
    // Tunables
    private const int PollIntervalMs   = 30_000;
    private const int RpcTimeoutMs     =  8_000;
    private const int BackoffOnErrorMs =  5_000;

    private static readonly string StatusRefreshing = "Refreshing devices\u2026";
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly IGatewayRpcChannel _rpc;
    private readonly INodesStore        _store;
    private readonly GatewayConnection  _connection;
    private readonly ILogger<NodesPollingHostedService> _logger;

    private CancellationTokenSource? _cts;
    private Task? _loopTask;

    public NodesPollingHostedService(
        IGatewayRpcChannel rpc,
        INodesStore store,
        GatewayConnection connection,
        ILogger<NodesPollingHostedService> logger)
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

                await Task.Delay(PollIntervalMs, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (GatewayResponseException ex) when (ex.Message.Contains("missing scope"))
            {
                _logger.LogDebug("node.list: scope not available ({Msg})", ex.Message);
                try { await Task.Delay(60_000, ct); }
                catch (OperationCanceledException) { return; }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("node.list poll error: {Message}", ex.Message);
                try { await Task.Delay(BackoffOnErrorMs, ct); }
                catch (OperationCanceledException) { return; }
            }
        }
    }

    private async Task RefreshAsync(CancellationToken ct)
    {
        if (_store.IsLoading) return;
        _store.SetLoading(true);

        try
        {
            var data     = await _rpc.RequestRawAsync("node.list", null, RpcTimeoutMs, ct);
            var response = JsonSerializer.Deserialize<NodeListResponse>(data, JsonOpts);
            _store.Apply(response?.Nodes ?? []);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // keep last nodes; show hint if empty.
            _logger.LogDebug("node.list cancelled; keeping last nodes");
            var hint = _store.Nodes.Count == 0 ? StatusRefreshing : null;
            _store.SetCancelled(hint);
        }
        catch (GatewayResponseException ex) when (ex.Message.Contains("missing scope"))
        {
            // Scope not granted — not transient, back off in LoopAsync.
            _logger.LogDebug("node.list: scope not available ({Msg})", ex.Message);
            _store.SetError(ex.Message);
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError("node.list failed: {Message}", ex.Message);
            _store.SetError(ex.Message);
        }
    }

    private sealed class NodeListResponse
    {
        [JsonPropertyName("ts")]
        public double? Ts { get; init; }

        [JsonPropertyName("nodes")]
        public IReadOnlyList<NodeInfo> Nodes { get; init; } = [];
    }
}
