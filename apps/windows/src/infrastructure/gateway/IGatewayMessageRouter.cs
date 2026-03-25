using System.Text.Json;

namespace OpenClawWindows.Infrastructure.Gateway;

// Called by the receive loop (GAP-017) to feed gateway frames into the RPC pending map.
// Kept internal so the routing contract stays within infrastructure.
internal interface IGatewayMessageRouter
{
    // Routes a "res" frame — completes the pending TaskCompletionSource for the given id.
    void RouteResponse(string id, bool ok, JsonElement? payload, JsonElement? error);

    // Routes an "event" frame — forwarded to subscribers for push handling.
    void RouteEvent(string eventName, JsonElement? payload);

    // Signals that the connect handshake (hello-ok) completed — unblocks pending RPCs.
    void NotifyHandshakeComplete();

    // Resets the handshake gate so new RPCs block until the next hello-ok.
    void ResetHandshakeGate();
}
