using OpenClawWindows.Application.Behaviors;

namespace OpenClawWindows.Application.RemoteTunnel;

[UseCase("UC-049")]
public sealed record DisconnectRemoteTunnelCommand : IRequest<ErrorOr<Success>>;

internal sealed class DisconnectRemoteTunnelHandler
    : IRequestHandler<DisconnectRemoteTunnelCommand, ErrorOr<Success>>
{
    private readonly IRemoteTunnelService _tunnelService;
    private readonly ILogger<DisconnectRemoteTunnelHandler> _logger;

    public DisconnectRemoteTunnelHandler(IRemoteTunnelService tunnelService,
        ILogger<DisconnectRemoteTunnelHandler> logger)
    {
        _tunnelService = tunnelService;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(DisconnectRemoteTunnelCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Disconnecting remote tunnel");
        await _tunnelService.DisconnectAsync(ct);
        return Result.Success;
    }
}
