namespace OpenClawWindows.Infrastructure.Gateway;

// Stub — remote tunnel via SSH/port-forward is tracked in GAP-023.
internal sealed class NullRemoteTunnelService : IRemoteTunnelService
{
    public bool IsConnected => false;

    public Task<ErrorOr<Success>> ConnectAsync(string tunnelEndpoint, int localPort, CancellationToken ct)
        => Task.FromResult<ErrorOr<Success>>(Error.Failure("tunnel.not_implemented",
            "Remote tunnel not yet implemented (GAP-023)"));

    public Task DisconnectAsync(CancellationToken ct) => Task.CompletedTask;
}
