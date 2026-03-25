using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace OpenClawWindows.Presentation.Tray.Components;

// Hosts arbitrary WinUI3 content with a system-accent highlight background on hover.
//         NSColor.selectedContentBackgroundColor fill in draw(_:) → HighlightPanel.Background
//         environment(\.menuItemHighlighted, hovered) → IsHighlighted DP for child bindings
internal sealed partial class MenuHighlightedHostView : UserControl
{
    // ── Dependency properties ──────────────────────────────────────────────────

    public static readonly DependencyProperty ContentWidthProperty =
        DependencyProperty.Register(nameof(ContentWidth), typeof(double), typeof(MenuHighlightedHostView),
            new PropertyMetadata(0.0, (d, _) => ((MenuHighlightedHostView)d).ApplySizing()));

    public static readonly DependencyProperty HostedContentProperty =
        DependencyProperty.Register(nameof(HostedContent), typeof(object), typeof(MenuHighlightedHostView),
            new PropertyMetadata(null, (d, _) => ((MenuHighlightedHostView)d).ApplyHostedContent()));

    // exposes hover state; replaces environment(\.menuItemHighlighted, ...)
    public static readonly DependencyProperty IsHighlightedProperty =
        DependencyProperty.Register(nameof(IsHighlighted), typeof(bool), typeof(MenuHighlightedHostView),
            new PropertyMetadata(false, (d, _) => ((MenuHighlightedHostView)d).UpdateHighlight()));

    public double ContentWidth
    {
        get => (double)GetValue(ContentWidthProperty);
        set => SetValue(ContentWidthProperty, value);
    }

    public object? HostedContent
    {
        get => GetValue(HostedContentProperty);
        set => SetValue(HostedContentProperty, value);
    }

    public bool IsHighlighted
    {
        get => (bool)GetValue(IsHighlightedProperty);
        private set => SetValue(IsHighlightedProperty, value);
    }

    public MenuHighlightedHostView()
    {
        InitializeComponent();
        PointerEntered += (_, _) => IsHighlighted = true;
        PointerExited  += (_, _) => IsHighlighted = false;
    }

    // refreshes content and sizing together
    public void Update(object content, double width)
    {
        HostedContent = content;
        ContentWidth  = width;
    }

    private void ApplySizing() => Width = Math.Max(1.0, ContentWidth);

    private void ApplyHostedContent() => HostedPresenter.Content = HostedContent;

    // paints selectedContentBackgroundColor when hovered
    private void UpdateHighlight() =>
        HighlightPanel.Background = IsHighlighted
            ? (Brush)Resources["SelectionBackground"]
            : null;
}
