using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Events;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.SystemTray;

namespace OpenClawWindows.Application.SystemTray;

// Triggered by gateway lifecycle events (EVT-001..005) to refresh tray icon/menu.
[UseCase("UC-036")]
public sealed record UpdateTrayMenuStateCommand(
    string ConnectionState,
    string? ActiveSessionLabel,
    string? UsageSummary,
    int ConnectedNodeCount,
    string? GatewayDisplayName,
    bool IsPaused) : IRequest<ErrorOr<Success>>;

internal sealed class UpdateTrayMenuStateHandler : IRequestHandler<UpdateTrayMenuStateCommand, ErrorOr<Success>>
{
    private readonly ITrayMenuStateStore _stateStore;
    private readonly IPublisher _publisher;
    private readonly ILogger<UpdateTrayMenuStateHandler> _logger;

    public UpdateTrayMenuStateHandler(
        ITrayMenuStateStore stateStore,
        IPublisher publisher,
        ILogger<UpdateTrayMenuStateHandler> logger)
    {
        _stateStore = stateStore;
        _publisher  = publisher;
        _logger     = logger;
    }

    public async Task<ErrorOr<Success>> Handle(UpdateTrayMenuStateCommand cmd, CancellationToken ct)
    {
        var trayState = TrayMenuState.Create(cmd.ConnectionState, cmd.ActiveSessionLabel,
            cmd.UsageSummary, cmd.ConnectedNodeCount, cmd.GatewayDisplayName, cmd.IsPaused);
        _stateStore.Update(trayState);

        var gatewayState = ResolveGatewayState(cmd.ConnectionState, cmd.IsPaused);
        await _publisher.Publish(new TrayMenuStateChangedEvent(gatewayState, cmd.ActiveSessionLabel), ct);

        _logger.LogDebug("TrayMenuState updated: connectionState={State}", cmd.ConnectionState);
        return Result.Success;
    }

    // IsPaused takes precedence — a paused node is still "connected" at the socket level.
    private static GatewayState ResolveGatewayState(string connectionState, bool isPaused)
    {
        if (isPaused) return GatewayState.Paused;

        return connectionState.ToLowerInvariant() switch
        {
            "connected"       => GatewayState.Connected,
            "connecting"      => GatewayState.Connecting,
            "reconnecting"    => GatewayState.Reconnecting,
            "voicewakeactive" => GatewayState.VoiceWakeActive,
            _                 => GatewayState.Disconnected,
        };
    }
}
