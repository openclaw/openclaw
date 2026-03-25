using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;
using Windows.Graphics;

namespace OpenClawWindows.Presentation.Tray;

internal sealed class HoverHUDController : IDisposable
{
    // Tunables
    private const int LogicalWidth     = 360;
    private const int LogicalHeight    = 74;
    private const int PaddingLogical   = 8;
    private const int ShowDelayMs      = 180;
    private const int DismissDelayMs   = 250;
    private const int LeaveCheckMs     = 60;
    private const int TrayIconRadiusPx = 24; // tolerance for "cursor still over tray icon"

    private readonly IServiceProvider _sp;

    private HoverHUDWindow? _window;
    private bool _hoveringStatusItem;
    private bool _hoveringPanel;
    private bool _isSuppressed;
    private bool _isVisible;
    private PointInt32 _anchorPt; // physical pixels from GetCursorPos at last TrayMouseMove

    private DispatcherTimer? _showTimer;
    private DispatcherTimer? _dismissTimer;
    private DispatcherTimer? _leaveCheckTimer;

    public HoverHUDController(IServiceProvider sp) => _sp = sp;

    // ─── Public API ───────────────────────────────────────────────────────────

    public void OnTrayMouseMove()
    {
        GetCursorPos(out var pt);
        _anchorPt = new PointInt32(pt.X, pt.Y);

        if (_isSuppressed) return;

        CancelDismiss();
        if (!_hoveringStatusItem)
        {
            _hoveringStatusItem = true;
            ScheduleShow();
            StartLeaveCheck();
        }
    }

    public void PanelHoverChanged(bool inside)
    {
        _hoveringPanel = inside;
        if (inside)
            CancelDismiss();
        else if (!_hoveringStatusItem)
            ScheduleDismiss();
    }

    public void OpenChat()
    {
        DismissWindow();
        var chatMgr = _sp.GetRequiredService<IWebChatManager>();
        _ = Task.Run(async () =>
        {
            var sessionKey = await chatMgr.GetPreferredSessionKeyAsync();
            await chatMgr.TogglePanelAsync(sessionKey, _anchorPt);
        });
    }

    public void Dismiss(string reason)
    {
        CancelShow();
        DismissWindow();
    }

    public void SetSuppressed(bool suppressed)
    {
        _isSuppressed = suppressed;
        if (suppressed) { CancelShow(); DismissWindow(); }
    }

    public void Dispose()
    {
        _showTimer?.Stop();
        _dismissTimer?.Stop();
        _leaveCheckTimer?.Stop();
        _window?.Close();
    }

    // ─── Leave detection ──────────────────────────────────────────────────────

    // Polls at LeaveCheckMs to detect when the cursor leaves both the tray icon
    // area and the panel.
    // (macOS uses NSEvent.addGlobalMonitorForEvents; Windows has no direct equivalent
    // for tray icon mouse-leave, so polling is the correct approach).
    private void StartLeaveCheck()
    {
        _leaveCheckTimer?.Stop();
        _leaveCheckTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(LeaveCheckMs) };
        _leaveCheckTimer.Tick += (_, _) =>
        {
            if (!_hoveringStatusItem && !_isVisible)
            {
                _leaveCheckTimer?.Stop();
                return;
            }
            if (IsMouseOverTrayArea() || IsMouseOverPanel()) return;

            _hoveringStatusItem = false;
            _leaveCheckTimer?.Stop();
            _leaveCheckTimer = null;
            CancelShow();
            ScheduleDismiss();
        };
        _leaveCheckTimer.Start();
    }

    private bool IsMouseOverTrayArea()
    {
        GetCursorPos(out var pt);
        return Math.Abs(pt.X - _anchorPt.X) <= TrayIconRadiusPx
            && Math.Abs(pt.Y - _anchorPt.Y) <= TrayIconRadiusPx;
    }

    private bool IsMouseOverPanel()
    {
        if (_window == null || !_isVisible) return false;
        GetCursorPos(out var pt);
        var appWin = _window.AppWindow;
        var pos    = appWin.Position;
        var size   = appWin.Size;
        return pt.X >= pos.X && pt.X <= pos.X + size.Width
            && pt.Y >= pos.Y && pt.Y <= pos.Y + size.Height;
    }

    // ─── Show / dismiss scheduling ────────────────────────────────────────────

    private void ScheduleShow()
    {
        _showTimer?.Stop();
        _showTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(ShowDelayMs) };
        _showTimer.Tick += (_, _) =>
        {
            _showTimer?.Stop();
            if (!_isSuppressed && _hoveringStatusItem) Present();
        };
        _showTimer.Start();
    }

    private void CancelShow()
    {
        _showTimer?.Stop();
        _showTimer = null;
    }

    private void ScheduleDismiss()
    {
        _dismissTimer?.Stop();
        _dismissTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(DismissDelayMs) };
        _dismissTimer.Tick += (_, _) =>
        {
            _dismissTimer?.Stop();
            if (!_hoveringStatusItem && !_hoveringPanel) DismissWindow();
        };
        _dismissTimer.Start();
    }

    private void CancelDismiss()
    {
        _dismissTimer?.Stop();
        _dismissTimer = null;
    }

    // ─── Window lifecycle ─────────────────────────────────────────────────────

    private void Present()
    {
        if (_window == null)
        {
            var vm = _sp.GetRequiredService<HoverHUDViewModel>();
            _window = new HoverHUDWindow(vm, this);
            _window.Closed += (_, _) => { _window = null; _isVisible = false; };
        }

        MoveAndShow();
        _isVisible = true;
    }

    private void MoveAndShow()
    {
        if (_window == null) return;

        var appWin = _window.AppWindow;

        // Compute DPI-aware physical pixel size.
        var hMon  = MonitorFromPoint(new NativePoint { X = _anchorPt.X, Y = _anchorPt.Y }, 2 /*MONITOR_DEFAULTTONEAREST*/);
        GetDpiForMonitor(hMon, 0, out var dpiX, out _);
        float scale = dpiX / 96f;

        int physW = (int)(LogicalWidth   * scale);
        int physH = (int)(LogicalHeight  * scale);
        int pad   = (int)(PaddingLogical * scale);

        // Position above the cursor; taskbar is at the bottom on Windows by default.
        int x = _anchorPt.X - physW / 2;
        int y = _anchorPt.Y - physH - pad;

        // Clamp to display work area.
        var da       = DisplayArea.GetFromPoint(_anchorPt, DisplayAreaFallback.Primary);
        var workArea = da.WorkArea;
        x = Math.Clamp(x, workArea.X + pad, workArea.X + workArea.Width  - physW - pad);
        y = Math.Max(workArea.Y + pad, y);

        appWin.MoveAndResize(new RectInt32(x, y, physW, physH));
        // Show without stealing keyboard focus (activateWindow: false).
        appWin.Show(activateWindow: false);
    }

    // Always recreate the window on each Show; Close releases OS resources cleanly.
    private void DismissWindow()
    {
        _isVisible = false;
        _window?.Close();
        _window = null;
    }

    // ─── P/Invoke ─────────────────────────────────────────────────────────────

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out NativePoint lpPoint);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(NativePoint pt, uint dwFlags);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hMonitor, uint dpiType, out uint dpiX, out uint dpiY);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int X; public int Y; }
}
