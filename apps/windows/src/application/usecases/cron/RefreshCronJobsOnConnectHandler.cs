using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Cron;

// On every gateway reconnect, signals the polling service to fetch fresh cron data.
// Without this, the store shows stale jobs after a WebSocket reconnect.
[UseCase("UC-056-cron-reconnect")]
internal sealed class RefreshCronJobsOnConnectHandler : INotificationHandler<GatewayConnected>
{
    private readonly ICronJobsStore _store;

    public RefreshCronJobsOnConnectHandler(ICronJobsStore store) => _store = store;

    public Task Handle(GatewayConnected notification, CancellationToken ct)
    {
        // Signal the polling service to do a poll on its next check cycle (≤ 500 ms).
        _store.SignalRefresh();
        return Task.CompletedTask;
    }
}
