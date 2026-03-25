using Microsoft.UI.Windowing;
using OpenClawWindows.Presentation.ViewModels;
using Windows.Graphics;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class VoiceOverlayWindow : Window
{
    private readonly VoiceOverlayViewModel _vm;

    // Tunables
    private const int OverlayWidth  = 440;
    private const int OverlayHeight = 80;

    public VoiceOverlayWindow(VoiceOverlayViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;

        ConfigurePresenter();
        PositionTopRight();

        // visible is always true when the window is shown; only IsEditing triggers focus change.
        _vm.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(VoiceOverlayViewModel.IsEditing))
                InnerView.UpdateFocusState(isVisible: true, _vm.IsEditing);
        };
    }

    // ── Window setup ─────────────────────────────────────────────────────────

    private void ConfigurePresenter()
    {
        // Borderless always-on-top overlay — required to appear over other apps during voice wake.
        // TeachingTip is not an option here: it only attaches to elements within the app's own window.
        var presenter = (AppWindow.Presenter as OverlappedPresenter)
                     ?? OverlappedPresenter.Create();
        presenter.SetBorderAndTitleBar(hasBorder: false, hasTitleBar: false);
        presenter.IsAlwaysOnTop  = true;
        presenter.IsResizable    = false;
        presenter.IsMinimizable  = false;
        presenter.IsMaximizable  = false;
        AppWindow.SetPresenter(presenter);
        AppWindow.Resize(new SizeInt32(OverlayWidth, OverlayHeight));
    }

    private void PositionTopRight()
    {
        // Position top-right of the primary work area, clear of taskbar.
        var workArea = DisplayArea.Primary.WorkArea;
        AppWindow.Move(new PointInt32(
            workArea.X + workArea.Width - OverlayWidth,
            workArea.Y));
    }

    // ── Pointer handlers ─────────────────────────────────────────────────────

    private void RootGrid_PointerEntered(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
        => _vm.IsHovering = true;

    private void RootGrid_PointerExited(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
        => _vm.IsHovering = false;

    // Drag to reposition.
    private void RootGrid_ManipulationDelta(object sender, Microsoft.UI.Xaml.Input.ManipulationDeltaRoutedEventArgs e)
    {
        var pos = AppWindow.Position;
        AppWindow.Move(new PointInt32(
            (int)(pos.X + e.Delta.Translation.X),
            (int)(pos.Y + e.Delta.Translation.Y)));
    }
}
