using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.Audio;

// Utilities for mic device-change detection and debounced refresh scheduling.
// voiceWakeBinding(for:) is SwiftUI-specific and has no WinUI3 counterpart — data
// binding is handled via [ObservableProperty] on VoiceWakeSettingsViewModel instead.
internal static class MicRefreshSupport
{
    // Tunables
    // 300_000_000 ns in Swift → 300 ms
    internal static readonly TimeSpan RefreshDelay = TimeSpan.FromMilliseconds(300);

    // and dispatches triggerRefresh() on the UI thread (DispatcherQueue ≡ @MainActor).
    internal static void StartObserver(IAudioCaptureDevice device, Action triggerRefresh)
    {
        device.DefaultDeviceChanged += (_, _) =>
        {
            DispatcherQueue? queue = null;
            try { queue = DispatcherQueue.GetForCurrentThread(); }
            catch (Exception) { } // WinRT COM not initialized in test hosts — treat as null

            if (queue is not null)
                queue.TryEnqueue(() => triggerRefresh());
            else
                triggerRefresh();
        };
    }

    // Cancels any pending debounced refresh and schedules action after RefreshDelay.
    // The caller owns pendingCts — pass by ref so Schedule can swap in the new token source.
    internal static void Schedule(ref CancellationTokenSource? pendingCts, Func<Task> action)
    {
        pendingCts?.Cancel();
        pendingCts?.Dispose();
        var cts = new CancellationTokenSource();
        pendingCts = cts;
        _ = RunDelayedAsync(cts.Token, action);
    }

    // Returns the display name of the device whose UID matches selectedId, or "" if not found.
    internal static string SelectedMicName<T>(
        string selectedId,
        IEnumerable<T> devices,
        Func<T, string> uid,
        Func<T, string> name)
    {
        if (string.IsNullOrEmpty(selectedId)) return "";
        foreach (var device in devices)
        {
            if (uid(device) == selectedId)
                return name(device);
        }
        return "";
    }

    private static async Task RunDelayedAsync(CancellationToken ct, Func<Task> action)
    {
        try
        {
            await Task.Delay(RefreshDelay, ct).ConfigureAwait(false);
            if (ct.IsCancellationRequested) return;
            await action().ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
    }
}
