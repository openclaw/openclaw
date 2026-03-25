using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Presentation.Tray;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class HoverHUDWindow : Window
{
    private readonly HoverHUDController _controller;

    internal HoverHUDWindow(HoverHUDViewModel vm, HoverHUDController controller)
    {
        _controller = controller;
        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;

        // Acrylic backdrop
        SystemBackdrop = new DesktopAcrylicBackdrop();

        // Borderless, always-on-top, no taskbar entry.
        var presenter = OverlappedPresenter.Create();
        presenter.IsAlwaysOnTop = true;
        presenter.IsResizable   = false;
        presenter.SetBorderAndTitleBar(hasBorder: false, hasTitleBar: false);

        var appWin = AppWindow;
        appWin.SetPresenter(presenter);
        appWin.IsShownInSwitchers = false;

        // Rounded corners on Windows 11 (DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND).
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        ApplyRoundedCorners(hwnd);
    }

    // PointerEntered/Exited forwarded to PanelHoverChanged on the controller.
    private void RootGrid_PointerEntered(object sender, PointerRoutedEventArgs e)
        => _controller.PanelHoverChanged(inside: true);

    private void RootGrid_PointerExited(object sender, PointerRoutedEventArgs e)
        => _controller.PanelHoverChanged(inside: false);

    // Tap opens WebChat
    private void RootGrid_PointerPressed(object sender, PointerRoutedEventArgs e)
        => _controller.OpenChat();

    private static void ApplyRoundedCorners(IntPtr hwnd)
    {
        // DWMWA_WINDOW_CORNER_PREFERENCE (33), DWMWCP_ROUND (2)
        int preference = 2;
        DwmSetWindowAttribute(hwnd, 33, ref preference, Marshal.SizeOf(preference));
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);
}
