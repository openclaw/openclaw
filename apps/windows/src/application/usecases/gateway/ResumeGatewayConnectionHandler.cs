using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-008")]
public sealed record ResumeGatewayCommand : IRequest<ErrorOr<Success>>;

internal sealed class ResumeGatewayConnectionHandler : IRequestHandler<ResumeGatewayCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _socket;
    private readonly GatewayConnection _connection;
    private readonly ISettingsRepository _settings;
    private readonly IMediator _mediator;
    private readonly ILogger<ResumeGatewayConnectionHandler> _logger;

    public ResumeGatewayConnectionHandler(
        IGatewayWebSocket socket,
        GatewayConnection connection,
        ISettingsRepository settings,
        IMediator mediator,
        ILogger<ResumeGatewayConnectionHandler> logger)
    {
        _socket     = socket;
        _connection = connection;
        _settings   = settings;
        _mediator   = mediator;
        _logger     = logger;
    }

    public async Task<ErrorOr<Success>> Handle(ResumeGatewayCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Resuming gateway connection");

        // Symmetric with PauseGatewayConnectionHandler: clear the in-memory Paused state
        // so the reconnect coordinator and node mode coordinator see Connected again.
        _connection.MarkResumed();

        // Clear persisted IsPaused so the coordinator does not skip auto-connect on restart.
        // IsPaused is a Windows-only field — it has no counterpart in the gateway config schema.
        // SaveLocalAsync avoids the gateway config.get/config.set round-trip, which would fail
        // here because the gateway socket is still disconnected (paused) at this point.
        var s = await _settings.LoadAsync(ct);
        s.SetIsPaused(false);
        await _settings.SaveLocalAsync(s, ct);

        await _socket.ResumeReceivingAsync(ct);
        await _mediator.Publish(new GatewayResumed(), ct);
        return Result.Success;
    }
}
