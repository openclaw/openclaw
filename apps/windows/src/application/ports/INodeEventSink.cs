namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Port for sending push events from the node to the gateway via the node WebSocket.
/// </summary>
public interface INodeEventSink
{
    // Best-effort: drops silently when not connected
    void TrySendEvent(string eventName, string? payloadJson);
}
