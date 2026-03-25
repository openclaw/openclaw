namespace OpenClawWindows.Domain.Gateway;

// SM-001: lifecycle states of the WebSocket connection
public enum GatewayConnectionState
{
    Disconnected,
    Connecting,
    Connected,
    Paused,
    Reconnecting,
}
