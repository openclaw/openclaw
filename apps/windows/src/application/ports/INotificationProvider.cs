using OpenClawWindows.Domain.Notifications;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Windows toast notification delivery.
/// Implemented by WinRTNotificationAdapter (Windows.UI.Notifications).
/// </summary>
public interface INotificationProvider
{
    Task<ErrorOr<Success>> ShowAsync(ToastNotificationRequest request, CancellationToken ct);
}
