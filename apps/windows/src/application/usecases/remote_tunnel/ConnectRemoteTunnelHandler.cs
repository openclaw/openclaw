using OpenClawWindows.Application.Behaviors;

namespace OpenClawWindows.Application.RemoteTunnel;

[UseCase("UC-048")]
public sealed record ConnectRemoteTunnelCommand(string TunnelEndpoint, int LocalPort)
    : IRequest<ErrorOr<Success>>;

internal sealed class ConnectRemoteTunnelHandler
    : IRequestHandler<ConnectRemoteTunnelCommand, ErrorOr<Success>>
{
    private readonly IRemoteTunnelService _tunnelService;
    private readonly ILogger<ConnectRemoteTunnelHandler> _logger;

    public ConnectRemoteTunnelHandler(IRemoteTunnelService tunnelService,
        ILogger<ConnectRemoteTunnelHandler> logger)
    {
        _tunnelService = tunnelService;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(ConnectRemoteTunnelCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.TunnelEndpoint, nameof(cmd.TunnelEndpoint));
        Guard.Against.NegativeOrZero(cmd.LocalPort, nameof(cmd.LocalPort));

        _logger.LogInformation("Connecting remote tunnel: endpoint={Endpoint} localPort={Port}",
            cmd.TunnelEndpoint, cmd.LocalPort);

        var result = await _tunnelService.ConnectAsync(cmd.TunnelEndpoint, cmd.LocalPort, ct);
        if (result.IsError)
            return Error.Failure("RT.CONNECT_FAILED", result.FirstError.Description);

        return Result.Success;
    }
}
