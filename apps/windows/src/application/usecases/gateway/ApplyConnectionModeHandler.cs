using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-019")]
public sealed record ApplyConnectionModeCommand(AppSettings Settings) : IRequest<ErrorOr<Success>>;

internal sealed class ApplyConnectionModeHandler : IRequestHandler<ApplyConnectionModeCommand, ErrorOr<Success>>
{
    // Local SSH tunnel binds to this port — matches DefaultWsPort in GatewayUriNormalizer
    private const int LocalTunnelPort = 18789;

    private readonly IMediator _mediator;
    private readonly GatewayConnection _connection;
    private readonly IRemoteTunnelService _tunnel;
    private readonly ILogger<ApplyConnectionModeHandler> _logger;

    public ApplyConnectionModeHandler(
        IMediator mediator,
        GatewayConnection connection,
        IRemoteTunnelService tunnel,
        ILogger<ApplyConnectionModeHandler> logger)
    {
        _mediator   = mediator;
        _connection = connection;
        _tunnel     = tunnel;
        _logger     = logger;
    }

    public async Task<ErrorOr<Success>> Handle(ApplyConnectionModeCommand cmd, CancellationToken ct)
    {
        var settings = cmd.Settings;
        var mode     = ResolveEffectiveMode(settings);

        _logger.LogInformation("Applying connection mode: {Mode}", mode);

        switch (mode)
        {
            case ConnectionMode.Unconfigured:
                // No gateway configured — stop tunnel and disconnect
                await _tunnel.DisconnectAsync(ct);
                await DisconnectIfNeededAsync("mode_unconfigured", ct);
                break;

            case ConnectionMode.Local:
                // Local gateway — stop any remote tunnel and let reconnect coordinator connect locally
                await _tunnel.DisconnectAsync(ct);
                await DisconnectIfNeededAsync("mode_changed_local", ct);
                break;

            case ConnectionMode.Remote when settings.RemoteTransport == RemoteTransport.Direct:
                // Direct WebSocket to remote URL — no SSH tunnel needed
                await _tunnel.DisconnectAsync(ct);
                await DisconnectIfNeededAsync("mode_changed_remote_direct", ct);
                break;

            case ConnectionMode.Remote:
                // SSH transport — start forwarding tunnel, then reconnect to local port
                await DisconnectIfNeededAsync("mode_changed_remote_ssh", ct);
                var target   = settings.RemoteTarget;
                var identity = settings.RemoteIdentity;
                if (!string.IsNullOrWhiteSpace(target))
                {
                    var tunnelEndpoint = string.IsNullOrWhiteSpace(identity)
                        ? target
                        : $"{identity}@{target}";

                    var result = await _tunnel.ConnectAsync(tunnelEndpoint, LocalTunnelPort, ct);
                    if (result.IsError)
                        // Non-fatal: coordinator will retry; tunnel may succeed after GAP-023
                        _logger.LogWarning("SSH tunnel connect failed: {Error}", result.FirstError.Description);
                }
                break;
        }

        return Result.Success;
    }

    // determines effective mode from AppSettings.
    // Follows the same precedence as the Swift enum: explicit configMode → remoteURL → onboarding.
    private static ConnectionMode ResolveEffectiveMode(AppSettings settings)
    {
        if (settings.ConnectionMode != ConnectionMode.Unconfigured)
            return settings.ConnectionMode;

        // Implicit remote: RemoteUrl set even when mode not explicitly configured
        if (!string.IsNullOrWhiteSpace(settings.RemoteUrl))
            return ConnectionMode.Remote;

        return settings.OnboardingSeen ? ConnectionMode.Local : ConnectionMode.Unconfigured;
    }

    private async Task DisconnectIfNeededAsync(string reason, CancellationToken ct)
    {
        if (_connection.State == GatewayConnectionState.Disconnected)
            return;

        await _mediator.Send(new DisconnectFromGatewayCommand(reason), ct);
    }
}
