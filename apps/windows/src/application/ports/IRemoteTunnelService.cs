namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Remote tunnel forwarding service.
/// </summary>
public interface IRemoteTunnelService
{
    bool IsConnected { get; }

    Task<ErrorOr<Success>> ConnectAsync(string tunnelEndpoint, int localPort, CancellationToken ct);
    Task DisconnectAsync(CancellationToken ct);
}
