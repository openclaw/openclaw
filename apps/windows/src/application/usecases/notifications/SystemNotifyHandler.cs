using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Notifications;

namespace OpenClawWindows.Application.Notifications;

[UseCase("UC-024")]
public sealed record SystemNotifyCommand(string ParamsJson) : IRequest<ErrorOr<Success>>;

internal sealed class SystemNotifyHandler : IRequestHandler<SystemNotifyCommand, ErrorOr<Success>>
{
    private readonly INotificationProvider _notifier;
    private readonly ILogger<SystemNotifyHandler> _logger;

    public SystemNotifyHandler(INotificationProvider notifier, ILogger<SystemNotifyHandler> logger)
    {
        _notifier = notifier;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(SystemNotifyCommand cmd, CancellationToken ct)
    {
        var requestResult = ToastNotificationRequest.FromJson(cmd.ParamsJson);
        if (requestResult.IsError)
            return requestResult.Errors;

        var result = await _notifier.ShowAsync(requestResult.Value, ct);
        if (result.IsError)
            _logger.LogWarning("system.notify failed: {Error}", result.FirstError.Description);

        return result;
    }
}
