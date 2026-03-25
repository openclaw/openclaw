namespace OpenClawWindows.Domain.Gateway;

// Superset of GatewayConnectionState — includes VoiceWakeActive for tray icon rendering.
public enum GatewayState
{
    Disconnected,
    Connecting,
    Connected,
    Paused,
    Reconnecting,
    VoiceWakeActive,
}
