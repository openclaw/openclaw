using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Sessions;

// Triggered by GatewayConnected event — creates a session record and refreshes tray.
[UseCase("UC-045a")]
internal sealed class CreateSessionHandler : INotificationHandler<GatewayConnected>
{
    private readonly ISessionStore _sessionStore;
    private readonly IMediator _mediator;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<CreateSessionHandler> _logger;

    public CreateSessionHandler(ISessionStore sessionStore, IMediator mediator,
        TimeProvider timeProvider, ILogger<CreateSessionHandler> logger)
    {
        _sessionStore = sessionStore;
        _mediator = mediator;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    public async Task Handle(GatewayConnected notification, CancellationToken ct)
    {
        _sessionStore.Add(notification.SessionKey, _timeProvider.GetUtcNow());
        _logger.LogInformation("Session created: sessionKey={SessionKey}", notification.SessionKey);

        var activeCount = _sessionStore.ActiveCount;
        await _mediator.Send(new UpdateTrayMenuStateCommand(
            "Connected", $"{activeCount} session(s)", null, activeCount, null, false), ct);
    }
}
