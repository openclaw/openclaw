using Microsoft.Extensions.Logging;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Presentation.Helpers;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;
using Windows.Graphics;

namespace OpenClawWindows.Presentation.Voice;

/// <summary>
/// Manages voice overlay window frame, presentation, and layout.
/// Handles targetFrame, measuredHeight, updateWindowFrame, dismissTargetFrame, present, and bringToFrontIfVisible.
/// </summary>
internal sealed class VoiceOverlayWindowController
{
    private readonly DispatcherQueue?                       _queue;
    private readonly ILogger<VoiceOverlayWindowController> _logger;

    private VoiceOverlayWindow? _window;
    private volatile bool       _isVisible;

    // Tunables
    internal const int Width          = 440;  // wider than Swift (360) — DPI-independent pixels
    internal const int Padding        = 10;
    internal const int ButtonWidth    = 36;
    internal const int Spacing        = 8;
    internal const int VerticalPadding = 8;
    internal const int MaxHeight      = 400;
    internal const int MinHeight      = 48;
    internal const int CloseOverflow  = 10;

    // measuredHeight approximation constants.
    private const int TextInsetWidth  = 2;
    private const int TextInsetHeight = 6;
    private const int AvgCharWidthPx  = 7;    // Approximation: 13pt system font ≈ 7px/char
    private const int LineHeightPx    = 20;   // Approximation: 13pt + leading ≈ 20px/line

    // dismissTargetFrame constants
    private const double ScaleEmpty      = 0.95;
    private const int    DismissShiftX   = 8;
    private const int    DismissShiftY   = 6;

    public bool IsVisible => _isVisible;

    internal VoiceOverlayWindowController(
        DispatcherQueue?                        queue,
        ILogger<VoiceOverlayWindowController>   logger)
    {
        _queue  = queue;
        _logger = logger;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    internal void Present(VoiceOverlayViewModel vm)
    {
        // Headless path (test context — no WinRT dispatcher).
        if (_queue is null) { _isVisible = true; return; }

        if (_window is not null)
        {
            // Window already exists — resize to current text height and bring to front.
            _isVisible = true;
            ApplyTargetFrame(vm.TranscriptText, animate: true);
            _window.Activate();
            return;
        }

        var target = TargetFrame(vm.TranscriptText);
        _window = new VoiceOverlayWindow(vm);
        _window.AppWindow.MoveAndResize(target);
        _window.Closed += (_, _) =>
        {
            _window    = null;
            _isVisible = false;
        };
        _isVisible = true;

        _logger.LogInformation(
            "overlay window present width={W} height={H}", target.Width, target.Height);
        _window.Activate();
    }

    internal void UpdateFrame(string text, bool animate)
    {
        if (_window is null || _queue is null) return;
        ApplyTargetFrame(text, animate);
    }

    internal void Dismiss(
        VoiceDismissReason reason,
        VoiceSendOutcome   outcome,
        Action?            onDismissed)
    {
        // Headless / already closed — fire callback immediately.
        if (_queue is null || _window is null)
        {
            _isVisible = false;
            onDismissed?.Invoke();
            return;
        }

        var winCopy    = _window;
        _window        = null;
        _isVisible     = false;

        var current = GetCurrentFrame(winCopy.AppWindow);
        var dismiss = DismissTargetFrame(current, reason, outcome);

        // Map dismiss target → translation offsets for AnimateDismiss.
        double offsetX = dismiss.HasValue ? dismiss.Value.X - current.X : OverlayPanelFactory.DismissOffsetX;
        double offsetY = dismiss.HasValue ? dismiss.Value.Y - current.Y : OverlayPanelFactory.DismissOffsetY;

        OverlayPanelFactory.AnimateDismiss(
            winCopy.AppWindow, _queue,
            offsetX: offsetX,
            offsetY: offsetY,
            completion: () =>
            {
                winCopy.Close();
                onDismissed?.Invoke();
            });
    }

    internal void BringToFrontIfVisible()
    {
        if (!_isVisible || _window is null) return;
        _window.Activate();
    }

    // ── Frame helpers — pure calculations (testable without WinRT) ────────────

    internal RectInt32 TargetFrame(string text)
    {
        var height      = MeasuredHeight(text);
        var totalWidth  = Width  + CloseOverflow * 2;
        var totalHeight = height + CloseOverflow * 2;
        var workArea    = DisplayArea.Primary.WorkArea;
        return new RectInt32(
            workArea.X + workArea.Width - totalWidth,
            workArea.Y,
            totalWidth,
            totalHeight);
    }

    // with a char-width heuristic (13pt system font ≈ 7px/char, line height ≈ 20px).
    internal static int MeasuredHeight(string text)
    {
        var containerWidth = Math.Max(1, Width - Padding * 2 - Spacing - ButtonWidth - TextInsetWidth * 2);
        var charsPerLine   = Math.Max(1, containerWidth / AvgCharWidthPx);
        var lines          = Math.Max(1, (int)Math.Ceiling((double)text.Length / charsPerLine));
        var contentHeight  = lines * LineHeightPx + TextInsetHeight * 2;
        var total          = contentHeight + VerticalPadding * 2;
        return Math.Clamp(total, MinHeight, MaxHeight);
    }

    // (.empty, _)          → scale 0.95 centered (appears to shrink)
    // (.explicit, .sent)   → offset (8, 6) — slides up-right
    // default              → unchanged frame
    internal static RectInt32? DismissTargetFrame(
        RectInt32          current,
        VoiceDismissReason reason,
        VoiceSendOutcome   outcome)
    {
        return (reason, outcome) switch
        {
            (VoiceDismissReason.Empty, _) =>
                ScaleFrame(current, ScaleEmpty),
            (VoiceDismissReason.Explicit, VoiceSendOutcome.Sent) =>
                new RectInt32(
                    current.X + DismissShiftX,
                    current.Y + DismissShiftY,
                    current.Width,
                    current.Height),
            _ => current
        };
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private void ApplyTargetFrame(string text, bool animate)
    {
        if (_window is null || _queue is null) return;
        var target = TargetFrame(text);
        OverlayPanelFactory.ApplyFrame(_window.AppWindow, target, animate, _queue);
    }

    private static RectInt32 ScaleFrame(RectInt32 frame, double scale)
    {
        var newWidth  = (int)(frame.Width  * scale);
        var newHeight = (int)(frame.Height * scale);
        var dx = (frame.Width  - newWidth)  / 2;
        var dy = (frame.Height - newHeight) / 2;
        return new RectInt32(frame.X + dx, frame.Y + dy, newWidth, newHeight);
    }

    private static RectInt32 GetCurrentFrame(AppWindow window)
    {
        var pos = window.Position;
        var sz  = window.Size;
        return new RectInt32(pos.X, pos.Y, sz.Width, sz.Height);
    }
}
