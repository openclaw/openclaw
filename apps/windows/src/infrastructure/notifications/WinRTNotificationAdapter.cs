using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Notifications;

namespace OpenClawWindows.Infrastructure.Notifications;

// Toast notification adapter (WinRT UWP notifications).
// Uses WinRT Windows.UI.Notifications — no capability declaration required for toasts.
internal sealed class WinRTNotificationAdapter : INotificationProvider
{
    private const string AppId = "OpenClaw";

    private readonly ILogger<WinRTNotificationAdapter> _logger;

    public WinRTNotificationAdapter(ILogger<WinRTNotificationAdapter> logger)
    {
        _logger = logger;
    }

    public Task<ErrorOr<Success>> ShowAsync(ToastNotificationRequest request, CancellationToken ct)
    {
        try
        {
            var xml = BuildToastXml(request);
            var toast = new ToastNotification(xml);

            // Optional auto-dismiss timeout (WinRT tag: duration)
            // Minimum 7 seconds enforced by Windows shell
            if (request.TimeoutMs.HasValue)
                toast.ExpirationTime = DateTimeOffset.Now.AddMilliseconds(request.TimeoutMs.Value);

            ToastNotificationManager.CreateToastNotifier(AppId).Show(toast);
            return Task.FromResult<ErrorOr<Success>>(Result.Success);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Toast notification failed for title='{T}'", request.Title);
            return Task.FromResult<ErrorOr<Success>>(
                Error.Failure("NOTIFICATION_FAILED", ex.Message));
        }
    }

    private static XmlDocument BuildToastXml(ToastNotificationRequest request)
    {
        var xml = ToastNotificationManager.GetTemplateContent(ToastTemplateType.ToastText02);
        var nodes = xml.GetElementsByTagName("text");
        nodes[0]!.InnerText = request.Title;
        nodes[1]!.InnerText = request.Body;

        if (request.ActionLabel is not null && request.ActionUrl is not null)
        {
            // Append an action button via raw XML mutation
            var actions = xml.CreateElement("actions");
            var action = xml.CreateElement("action");
            action.SetAttribute("content", request.ActionLabel);
            action.SetAttribute("arguments", request.ActionUrl);
            action.SetAttribute("activationType", "foreground");
            actions.AppendChild(action);
            xml.DocumentElement!.AppendChild(actions);
        }

        return xml;
    }
}
