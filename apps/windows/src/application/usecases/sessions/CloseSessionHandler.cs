using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Sessions;

// Triggered by GatewayDisconnected event.
[UseCase("UC-045b")]
internal sealed class CloseSessionHandler : INotificationHandler<GatewayDisconnected>
{
    private readonly ISessionStore _sessionStore;
    private readonly IMediator _mediator;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<CloseSessionHandler> _logger;

    public CloseSessionHandler(ISessionStore sessionStore, IMediator mediator,
        TimeProvider timeProvider, ILogger<CloseSessionHandler> logger)
    {
        _sessionStore = sessionStore;
        _mediator = mediator;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    public async Task Handle(GatewayDisconnected notification, CancellationToken ct)
    {
        _sessionStore.CloseActive(_timeProvider.GetUtcNow());
        _logger.LogInformation("Session closed");

        await _mediator.Send(new UpdateTrayMenuStateCommand(
            "Disconnected", null, null, 0, null, false), ct);
    }
}
