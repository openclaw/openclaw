using System.Text.Json;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Health;

namespace OpenClawWindows.Infrastructure.Stores;

internal sealed class InMemoryHeartbeatStore : IHeartbeatStore
{
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private readonly Lock _lock = new();
    private GatewayHeartbeatEvent? _lastEvent;

    public GatewayHeartbeatEvent? LastEvent
    {
        get { lock (_lock) { return _lastEvent; } }
    }

    public void HandleHeartbeat(JsonElement payload)
    {
        var evt = TryDecode(payload);
        if (evt is null) return;
        lock (_lock) { _lastEvent = evt; }
    }

    public async Task TryFetchInitialAsync(IGatewayRpcChannel rpc, CancellationToken ct = default)
    {
        GatewayHeartbeatEvent? current;
        lock (_lock) { current = _lastEvent; }
        if (current is not null) return;

        try
        {
            var evt = await rpc.LastHeartbeatAsync(ct);
            if (evt is null) return;
            // Only set if still empty — a push event may have arrived concurrently
            lock (_lock) { _lastEvent ??= evt; }
        }
        catch
        {
            // best-effort
        }
    }

    private static GatewayHeartbeatEvent? TryDecode(JsonElement payload)
    {
        try { return JsonSerializer.Deserialize<GatewayHeartbeatEvent>(payload.GetRawText(), JsonOpts); }
        catch { return null; }
    }
}
