using System.Text.Json;
using OpenClawWindows.Domain.Health;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// In-memory cache of the last gateway heartbeat event.
/// </summary>
public interface IHeartbeatStore
{
    GatewayHeartbeatEvent? LastEvent { get; }

    // Called by the gateway router when a "heartbeat" push event arrives.
    void HandleHeartbeat(JsonElement payload);

    // if LastEvent is null, requests last-heartbeat RPC.
    // Called by GatewayConnectivityCoordinator on connect — best-effort, swallows errors.
    Task TryFetchInitialAsync(IGatewayRpcChannel rpc, CancellationToken ct = default);
}
