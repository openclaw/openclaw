using Windows.UI.Notifications;

namespace OpenClawWindows.Presentation.Tray.Components;

/// <summary>In-app toast notification helper using Windows.UI.Notifications.</summary>
// Previous implementation was a borderless Window with manual animation and positioning.
// Native toasts appear in the Windows notification area and persist in Action Center (Win+N).
internal static class NotifyOverlay
{
    // Tunables
    internal const int AutoDismissMs = 6_000;

    // Tag used to identify and remove the notification via History.Remove().
    private const string Tag = "openclaw-notify";

    internal static void Present(string title, string body, int autoDismissAfterMs = AutoDismissMs)
    {
        var xml   = ToastNotificationManager.GetTemplateContent(ToastTemplateType.ToastText02);
        var texts = xml.GetElementsByTagName("text");
        texts[0].InnerText = title;
        texts[1].InnerText = body;

        var toast = new ToastNotification(xml) { Tag = Tag };
        // Schedule dismiss only when ExpirationTime is positive.
        if (autoDismissAfterMs > 0)
            toast.ExpirationTime = DateTimeOffset.Now.AddMilliseconds(autoDismissAfterMs);

        ToastNotificationManager.CreateToastNotifier().Show(toast);
    }

    internal static void Dismiss()
        => ToastNotificationManager.History.Remove(Tag);
}
