using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-019")]
public sealed record ApplyConnectionModeCommand(AppSettings Settings) : IRequest<ErrorOr<Success>>;

internal sealed class ApplyConnectionModeHandler : IRequestHandler<ApplyConnectionModeCommand, ErrorOr<Success>>
{
    // Tunables
    private const int LocalTunnelPort          = 18789;
    private const int GatewayReadyTimeoutSecs  = 6;

    private readonly IMediator                          _mediator;
    private readonly GatewayConnection                  _connection;
    private readonly IRemoteTunnelService               _tunnel;
    private readonly IGatewayProcessManager             _processManager;
    private readonly ILogger<ApplyConnectionModeHandler> _logger;

    public ApplyConnectionModeHandler(
        IMediator                          mediator,
        GatewayConnection                  connection,
        IRemoteTunnelService               tunnel,
        IGatewayProcessManager             processManager,
        ILogger<ApplyConnectionModeHandler> logger)
    {
        _mediator       = mediator;
        _connection     = connection;
        _tunnel         = tunnel;
        _processManager = processManager;
        _logger         = logger;
    }

    public async Task<ErrorOr<Success>> Handle(ApplyConnectionModeCommand cmd, CancellationToken ct)
    {
        var settings = cmd.Settings;
        var mode     = ResolveEffectiveMode(settings);

        _logger.LogInformation("Applying connection mode: {Mode}", mode);

        switch (mode)
        {
            case ConnectionMode.Unconfigured:
                // No gateway configured — stop process, tunnel, and socket
                _processManager.SetActive(false);
                await _tunnel.DisconnectAsync(ct);
                await DisconnectIfNeededAsync("mode_unconfigured", ct);
                break;

            case ConnectionMode.Local:
                // Local gateway — stop remote tunnel, start (or keep) local process, then reconnect
                await _tunnel.DisconnectAsync(ct);
                await DisconnectIfNeededAsync("mode_changed_local", ct);
                if (GatewayAutostartPolicy.ShouldStartGateway(ConnectionMode.Local, settings.IsPaused))
                {
                    _processManager.SetActive(true);
                    await _processManager.WaitForGatewayReadyAsync(
                        TimeSpan.FromSeconds(GatewayReadyTimeoutSecs), ct);
                }
                else
                {
                    _processManager.SetActive(false);
                }
                break;

            case ConnectionMode.Remote when settings.RemoteTransport == RemoteTransport.Direct:
                // Direct WebSocket to remote URL — no SSH tunnel, no local gateway process
                _processManager.SetActive(false);
                await _tunnel.DisconnectAsync(ct);
                await DisconnectIfNeededAsync("mode_changed_remote_direct", ct);
                break;

            case ConnectionMode.Remote:
                // SSH transport — local gateway not needed; start forwarding tunnel, then reconnect
                _processManager.SetActive(false);
                await DisconnectIfNeededAsync("mode_changed_remote_ssh", ct);
                var target   = settings.RemoteTarget;
                var identity = settings.RemoteIdentity;
                if (!string.IsNullOrWhiteSpace(target))
                {
                    var tunnelEndpoint = string.IsNullOrWhiteSpace(identity)
                        ? target
                        : $"{identity}@{target}";

                    var remotePort = ResolveRemotePort(settings);
                    var result = await _tunnel.ConnectAsync(tunnelEndpoint, LocalTunnelPort, remotePort, ct);
                    if (result.IsError)
                        // Non-fatal: coordinator will retry; tunnel may succeed after GAP-023
                        _logger.LogWarning("SSH tunnel connect failed: {Error}", result.FirstError.Description);
                }
                break;
        }

        return Result.Success;
    }

    private static int ResolveRemotePort(AppSettings settings)
    {
        var raw = settings.RemoteUrl?.Trim();
        if (!string.IsNullOrEmpty(raw) && Uri.TryCreate(raw, UriKind.Absolute, out var url))
        {
            var portStr = url.GetComponents(UriComponents.Port, UriFormat.Unescaped);
            if (!string.IsNullOrEmpty(portStr) && int.TryParse(portStr, out var explicit0))
                return explicit0;
            // wss:// defaults to 443; ws:// defaults to LocalTunnelPort
            return url.Scheme.ToLowerInvariant() == "wss" ? 443 : LocalTunnelPort;
        }
        return LocalTunnelPort;
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
