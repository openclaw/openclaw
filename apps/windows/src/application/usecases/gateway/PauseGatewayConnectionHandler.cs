using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-007")]
public sealed record PauseGatewayCommand : IRequest<ErrorOr<Success>>;

internal sealed class PauseGatewayConnectionHandler : IRequestHandler<PauseGatewayCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _socket;
    private readonly GatewayConnection _connection;
    private readonly ISettingsRepository _settings;
    private readonly IMediator _mediator;
    private readonly ILogger<PauseGatewayConnectionHandler> _logger;

    public PauseGatewayConnectionHandler(
        IGatewayWebSocket socket,
        GatewayConnection connection,
        ISettingsRepository settings,
        IMediator mediator,
        ILogger<PauseGatewayConnectionHandler> logger)
    {
        _socket     = socket;
        _connection = connection;
        _settings   = settings;
        _mediator   = mediator;
        _logger     = logger;
    }

    public async Task<ErrorOr<Success>> Handle(PauseGatewayCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Pausing gateway connection");

        // Update the in-memory state machine so the reconnect coordinator sees Paused
        // and does not immediately attempt to reconnect.
        if (_connection.State == GatewayConnectionState.Connected)
            _connection.MarkPaused();

        // Persist IsPaused so the coordinator does not auto-connect on the next app start.
        // IsPaused is a Windows-only field — it has no counterpart in the gateway config schema.
        // SaveLocalAsync avoids the gateway config.get/config.set round-trip, which can fail
        // if the gateway is transiently unavailable, causing the pause action to fail entirely.
        var s = await _settings.LoadAsync(ct);
        s.SetIsPaused(true);
        await _settings.SaveLocalAsync(s, ct);

        await _socket.SuspendReceivingAsync(ct);
        await _mediator.Publish(new GatewayPaused(), ct);
        return Result.Success;
    }
}
