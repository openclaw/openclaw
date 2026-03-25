using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Windows.System;
using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Presentation.Tray;
using Windows.Graphics;
using WinUIEx;

namespace OpenClawWindows.Presentation.Windows;

/// <summary>
/// Borderless, always-on-top popup that hosts TrayContextMenu.
/// Auto-hides when the window loses activation, mirroring macOS menu-dismiss behavior.
/// Pre-created once and reused via Hide/Show to avoid post-idle creation crashes.
/// </summary>
internal sealed partial class TrayContextMenuWindow : WindowEx
{
    // Tunables
    private const int MenuWidth      = 320; // logical pixels
    private const int MaxMenuHeight  = 640;
    private const int TaskbarClearance = 4;  // gap between menu bottom and cursor/taskbar

    private readonly SystemTrayViewModel _viewModel;
    private bool _styleApplied;

    internal TrayContextMenuWindow(SystemTrayViewModel viewModel)
    {
        _viewModel = viewModel;
        InitializeComponent();

        MenuContent.DataContext = viewModel;

        // Acrylic backdrop
        SystemBackdrop = new DesktopAcrylicBackdrop();

        // Borderless, always-on-top, no taskbar entry.
        this.IsAlwaysOnTop = true;
        this.IsResizable = false;
        this.IsMinimizable = false;

        AppWindow.IsShownInSwitchers = false;
        AppWindow.TitleBar.ExtendsContentIntoTitleBar = true;

        // Auto-hide when the menu loses focus
        Activated += OnActivated;

        // Escape key dismisses the menu
        MenuContent.KeyDown += (_, e) =>
        {
            if (e.Key == VirtualKey.Escape)
            {
                e.Handled = true;
                this.Hide();
                _viewModel.OnMenuClosed();
            }
        };
    }

    private void OnActivated(object sender, WindowActivatedEventArgs args)
    {
        if (args.WindowActivationState == WindowActivationState.Deactivated)
        {
            this.Hide();
            _viewModel.OnMenuClosed();
        }
    }

    // Positions the window near the cursor, activates it, and forces foreground
    // so that clicking anywhere else triggers Deactivated → Hide.
    internal void ShowAtCursor()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);

        // Remove title bar via Win32 (once, on first show)
        if (!_styleApplied)
        {
            int style = GetWindowLong(hwnd, GWL_STYLE);
            style &= ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU);
            SetWindowLong(hwnd, GWL_STYLE, style);
            // SWP_FRAMECHANGED forces the style change to take effect immediately.
            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
            ApplyRoundedCorners(hwnd);
            _styleApplied = true;
        }

        GetCursorPos(out var cursor);

        // Multi-monitor: get the work area of the monitor where the cursor is.
        var hMonitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        var mi = new MONITORINFO { CbSize = Marshal.SizeOf<MONITORINFO>() };
        RECT workArea;
        if (GetMonitorInfo(hMonitor, ref mi))
        {
            workArea = mi.RcWork;
        }
        else
        {
            // Fallback: primary screen via GetSystemMetrics.
            workArea = new RECT
            {
                Left = 0, Top = 0,
                Right = GetSystemMetrics(SM_CXSCREEN),
                Bottom = GetSystemMetrics(SM_CYSCREEN),
            };
        }

        var dpi = GetDpiForWindow(hwnd);
        var scale = dpi / 96.0;
        var scaledW = (int)(MenuWidth * scale);
        var scaledH = (int)(MaxMenuHeight * scale);

        // Horizontal: clamp within work area.
        var x = Math.Max(workArea.Left, Math.Min(cursor.X, workArea.Right - scaledW));

        // Compute Y using helper — reused after auto-resize.
        int y = ComputeY(cursor.Y, scaledH, in workArea);

        AppWindow.Move(new PointInt32(x, y));
        AppWindow.ResizeClient(new SizeInt32(MenuWidth, MaxMenuHeight));

        // Activate + force foreground so the OS delivers WM_ACTIVATE(WA_INACTIVE)
        // when the user clicks anywhere outside this window.
        Activate();
        SetForegroundWindow(hwnd);

        // Auto-size to actual content after first layout pass.
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Normal, () =>
        {
            var contentH = MenuContent.ActualHeight;
            if (contentH > 0 && contentH < MaxMenuHeight)
            {
                var newScaledH = (int)(contentH * scale);
                var newY = ComputeY(cursor.Y, newScaledH, in workArea);
                AppWindow.Move(new PointInt32(x, newY));
                AppWindow.ResizeClient(new SizeInt32(MenuWidth, (int)Math.Ceiling(contentH)));
            }
        });
    }

    private static int ComputeY(int cursorY, int scaledH, in RECT workArea)
    {
        int yAbove = cursorY - scaledH - TaskbarClearance;
        int yBelow = cursorY + TaskbarClearance;
        if (yAbove >= workArea.Top)
            return Math.Min(yAbove, workArea.Bottom - scaledH);
        if (yBelow + scaledH <= workArea.Bottom)
            return Math.Max(yBelow, workArea.Top);
        return Math.Max(workArea.Top, Math.Min(yAbove, workArea.Bottom - scaledH));
    }

    // Triggers data-load (settings, sessions) right before the menu is visible.
    internal async Task PrepareAsync()
    {
        await _viewModel.PrepareAsync();
    }

    private static void ApplyRoundedCorners(IntPtr hwnd)
    {
        // DWMWA_WINDOW_CORNER_PREFERENCE (33), DWMWCP_ROUND (2)
        int preference = 2;
        DwmSetWindowAttribute(hwnd, 33, ref preference, Marshal.SizeOf(preference));
    }

    // Win32 style constants
    private const int GWL_STYLE      = -16;
    private const int WS_CAPTION     = 0x00C00000;
    private const int WS_THICKFRAME  = 0x00040000;
    private const int WS_SYSMENU     = 0x00080000;
    private const uint SWP_NOMOVE       = 0x0002;
    private const uint SWP_NOSIZE       = 0x0001;
    private const uint SWP_NOZORDER     = 0x0004;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const int SM_CXSCREEN    = 0;
    private const int SM_CYSCREEN    = 1;
    private const uint MONITOR_DEFAULTTONEAREST = 2;

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MONITORINFO
    {
        public int CbSize;
        public RECT RcMonitor;
        public RECT RcWork;
        public uint DwFlags;
    }
}
