using System.Text.Json;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Event source for gateway push events consumed by the chat ViewModel.
/// Decouples presentation ViewModels from GatewayRpcChannelAdapter.
/// </summary>
public interface IChatPushSource
{
    // Raised when the gateway pushes a "chat" event (state changes, message streaming).
    event Action<JsonElement>? ChatEventReceived;

    // Raised when the gateway pushes an "agent" event (streaming text, tool calls).
    event Action<JsonElement>? AgentEventReceived;

    // Raised when the gateway pushes a "health" event or the hello snapshot contains health.
    // ok=true means the gateway is healthy. Mirrors .health(ok:) in OpenClawChatTransportEvent.
    event Action<bool>? HealthReceived;

    // Raised on gateway "tick" — used to trigger periodic health polling.
    event Action? TickReceived;

    // Raised when the gateway signals a sequence gap — missed push events.
    event Action? SeqGapReceived;
}
