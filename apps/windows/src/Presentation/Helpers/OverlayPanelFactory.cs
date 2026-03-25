using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Windows.Graphics;

namespace OpenClawWindows.Presentation.Helpers;

/// <summary>Factory for creating and animating borderless overlay windows.</summary>
// NSPanel + NSAnimationContext → OverlappedPresenter + DispatcherQueueTimer.
// @MainActor → DispatcherQueue parameter (explicit threading contract instead of implicit actor).
// window.alphaValue → SetLayeredWindowAttributes(LWA_ALPHA) via P/Invoke.
// collectionBehavior [.canJoinAllSpaces, .transient] → AppWindow.IsShownInSwitchers = false.
// clearGlobalEventMonitor (NSEvent.removeMonitor) → not applicable on Windows; omitted.
internal static class OverlayPanelFactory
{
    // Tunables
    internal static readonly TimeSpan AnimatePresentDuration = TimeSpan.FromSeconds(0.18);
    internal static readonly TimeSpan AnimateFrameDuration   = TimeSpan.FromSeconds(0.12);
    internal static readonly TimeSpan AnimateDismissDuration = TimeSpan.FromSeconds(0.16);
    internal const double PresentStartOffsetY    = -6;    // negative = above target in Y-down coords
    internal const double DismissOffsetX         = 6;
    internal const double DismissOffsetY         = 6;

    // ~60 fps timer interval for all animations
    private const int FrameIntervalMs = 16;

    // ── Public API ────────────────────────────────────────────────────────────

    // Configures an AppWindow as a borderless, always-on-top overlay excluded from the task switcher.
    internal static void ConfigureOverlayPresenter(AppWindow appWindow)
    {
        var presenter = OverlappedPresenter.Create();
        presenter.SetBorderAndTitleBar(hasBorder: false, hasTitleBar: false);
        presenter.IsAlwaysOnTop  = true;
        presenter.IsResizable    = false;
        presenter.IsMinimizable  = false;
        presenter.IsMaximizable  = false;
        appWindow.SetPresenter(presenter);
        // exclude from Alt+Tab
        appWindow.IsShownInSwitchers = false;
    }

    // Slides from start to target while fading in from alpha=0 to alpha=1.
    internal static void AnimatePresent(
        AppWindow window, RectInt32 start, RectInt32 target,
        DispatcherQueue queue, TimeSpan duration = default)
    {
        var d = duration == default ? AnimatePresentDuration : duration;
        // Start invisible, position at start frame, then show.
        window.MoveAndResize(start);
        SetAlpha(window, 0);
        window.Show();

        RunAnimation(queue, d,
            onTick: t =>
            {
                window.MoveAndResize(Lerp(start, target, t));
                SetAlpha(window, (byte)(255 * t));
            },
            onComplete: () =>
            {
                window.MoveAndResize(target);
                SetAlpha(window, 255);
            });
    }

    // Slides the window from its current frame to target with easeOut.
    internal static void AnimateFrame(
        AppWindow window, RectInt32 target,
        DispatcherQueue queue, TimeSpan duration = default)
    {
        var d    = duration == default ? AnimateFrameDuration : duration;
        var from = CurrentFrame(window);
        RunAnimation(queue, d,
            onTick: t => window.MoveAndResize(Lerp(from, target, t)),
            onComplete: () => window.MoveAndResize(target));
    }

    internal static void ApplyFrame(AppWindow? window, RectInt32 target, bool animate, DispatcherQueue queue)
    {
        if (window is null) return;
        if (animate)
            AnimateFrame(window, target, queue);
        else
            window.MoveAndResize(target);
    }

    // On first present: animates from (target offset by startOffsetY) to target.
    // On subsequent present: invokes onAlreadyVisible for caller to handle.
    internal static void Present(
        AppWindow? window, bool isFirstPresent, RectInt32 target,
        DispatcherQueue queue,
        double startOffsetY             = PresentStartOffsetY,
        Action? onFirstPresent          = null,
        Action<AppWindow>? onAlreadyVisible = null)
    {
        if (window is null) return;
        if (isFirstPresent)
        {
            onFirstPresent?.Invoke();
            // Y-down Windows: startOffsetY=-6 places start 6px above target (slides down into position).
            var start = new RectInt32(target.X, (int)(target.Y + startOffsetY), target.Width, target.Height);
            AnimatePresent(window, start, target, queue);
        }
        else
        {
            onAlreadyVisible?.Invoke(window);
        }
    }

    // Slides window by (offsetX, offsetY) while fading out, then calls completion.
    internal static void AnimateDismiss(
        AppWindow window, DispatcherQueue queue,
        double offsetX     = DismissOffsetX,
        double offsetY     = DismissOffsetY,
        TimeSpan duration  = default,
        Action? completion = null)
    {
        var d    = duration == default ? AnimateDismissDuration : duration;
        var from = CurrentFrame(window);
        var to   = new RectInt32(
            (int)(from.X + offsetX), (int)(from.Y + offsetY),
            from.Width, from.Height);

        RunAnimation(queue, d,
            onTick: t =>
            {
                window.MoveAndResize(Lerp(from, to, t));
                SetAlpha(window, (byte)(255 * (1 - t)));
            },
            onComplete: () =>
            {
                window.MoveAndResize(to);
                SetAlpha(window, 0);
                completion?.Invoke();
            });
    }

    internal static void AnimateDismissAndHide(
        AppWindow window, DispatcherQueue queue,
        double offsetX    = DismissOffsetX,
        double offsetY    = DismissOffsetY,
        TimeSpan duration = default,
        Action? onHidden  = null)
    {
        AnimateDismiss(window, queue, offsetX, offsetY, duration, completion: () =>
        {
            window.Hide();
            SetAlpha(window, 255); // restore opacity for next AnimatePresent call
            onHidden?.Invoke();
        });
    }

    // ── Internal helpers (exposed for unit tests) ─────────────────────────────

    // quadratic easeOut approximation.
    internal static double EaseOut(double t) => 1 - Math.Pow(1 - t, 2);

    internal static RectInt32 Lerp(RectInt32 from, RectInt32 to, double t)
    {
        return new RectInt32(
            (int)Math.Round(from.X      + (to.X      - from.X)      * t),
            (int)Math.Round(from.Y      + (to.Y      - from.Y)      * t),
            (int)Math.Round(from.Width  + (to.Width  - from.Width)  * t),
            (int)Math.Round(from.Height + (to.Height - from.Height) * t));
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private static void RunAnimation(DispatcherQueue queue, TimeSpan duration, Action<double> onTick, Action? onComplete)
    {
        var startMs      = Environment.TickCount64;
        var durationMs   = duration.TotalMilliseconds;
        var timer        = queue.CreateTimer();
        timer.Interval    = TimeSpan.FromMilliseconds(FrameIntervalMs);
        timer.IsRepeating = true;
        timer.Tick += (t, _) =>
        {
            var rawT  = Math.Clamp((Environment.TickCount64 - startMs) / durationMs, 0.0, 1.0);
            var eased = EaseOut(rawT);
            onTick(eased);
            if (rawT >= 1.0)
            {
                t.Stop();
                onComplete?.Invoke();
            }
        };
        timer.Start();
    }

    private static RectInt32 CurrentFrame(AppWindow window)
    {
        var pos = window.Position;
        var sz  = window.Size;
        return new RectInt32(pos.X, pos.Y, sz.Width, sz.Height);
    }

    // ── Win32 — window opacity ─────────────────

    private static void SetAlpha(AppWindow window, byte alpha)
    {
        var hwnd  = Win32Interop.GetWindowFromWindowId(window.Id);
        var style = GetWindowLong(hwnd, GWL_EXSTYLE);
        if ((style & WS_EX_LAYERED) == 0)
            SetWindowLong(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED);
        SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
    }

    private const int  GWL_EXSTYLE   = -20;
    private const int  WS_EX_LAYERED = 0x00080000;
    private const uint LWA_ALPHA     = 0x00000002;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int newLong);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);
}
