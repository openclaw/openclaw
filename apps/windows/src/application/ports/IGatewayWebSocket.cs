using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Persistent WebSocket connection to the OpenClaw gateway.
/// Implemented by GatewayWebSocketAdapter (System.Net.WebSockets).
/// </summary>
public interface IGatewayWebSocket
{
    bool IsConnected { get; }

    Task ConnectAsync(GatewayEndpoint endpoint, CancellationToken ct);
    Task DisconnectAsync();
    Task<ErrorOr<Success>> SendAsync(string json, CancellationToken ct);
    IAsyncEnumerable<string> ReceiveMessagesAsync(CancellationToken ct);
    Task SuspendReceivingAsync(CancellationToken ct);
    Task ResumeReceivingAsync(CancellationToken ct);
}
