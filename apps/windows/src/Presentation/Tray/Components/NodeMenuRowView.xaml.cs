using Microsoft.UI.Text;
using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Domain.Nodes;

namespace OpenClawWindows.Presentation.Tray.Components;

/// <summary>
/// Single node row for the tray menu.
/// </summary>
internal sealed partial class NodeMenuRowView : UserControl
{
    // Tunables
    internal const double PaddingVertical  = 8;
    internal const double PaddingLeading   = 18;
    internal const double PaddingTrailing  = 12;
    internal const double IconSize         = 22;
    internal const double HStackSpacing    = 10;
    internal const double ContentSpacing   = 2;

    // ── Dependency properties ─────────────────────────────────────────────────

    public static readonly DependencyProperty NodeProperty =
        DependencyProperty.Register(nameof(Node), typeof(object), typeof(NodeMenuRowView),
            new PropertyMetadata(null, (d, _) => ((NodeMenuRowView)d).ApplyNode()));

    public static readonly DependencyProperty IsHighlightedProperty =
        DependencyProperty.Register(nameof(IsHighlighted), typeof(bool), typeof(NodeMenuRowView),
            new PropertyMetadata(false, (d, _) => ((NodeMenuRowView)d).ApplyColors()));

    // Typed as object? to avoid XAML type-info issues with the record type.
    public object? Node
    {
        get => GetValue(NodeProperty);
        set => SetValue(NodeProperty, value);
    }

    public bool IsHighlighted
    {
        get => (bool)GetValue(IsHighlightedProperty);
        set => SetValue(IsHighlightedProperty, value);
    }

    public NodeMenuRowView()
    {
        InitializeComponent();
        RootGrid.Padding = new Thickness(PaddingLeading, PaddingVertical, PaddingTrailing, PaddingVertical);
    }

    private void ApplyNode()
    {
        var entry = Node as NodeInfo;
        if (entry is null) return;

        // Leading icon glyph
        LeadingIcon.Glyph = NodeMenuEntryFormatter.LeadingGlyph(entry);

        // primaryName
        PrimaryNameBlock.Text       = NodeMenuEntryFormatter.PrimaryName(entry);
        PrimaryNameBlock.FontWeight = NodeMenuEntryFormatter.IsConnected(entry)
            ? FontWeights.SemiBold
            : FontWeights.Normal;

        // headlineRight
        var headlineRight = NodeMenuEntryFormatter.HeadlineRight(entry);
        if (headlineRight is not null)
        {
            HeadlineRightBlock.Text       = headlineRight;
            HeadlineRightBlock.Visibility = Visibility.Visible;
        }
        else
        {
            HeadlineRightBlock.Visibility = Visibility.Collapsed;
        }

        // detailLeft
        DetailLeftBlock.Text = NodeMenuEntryFormatter.DetailLeft(entry);

        // detailRightVersion
        var version = NodeMenuEntryFormatter.DetailRightVersion(entry);
        if (version is not null)
        {
            DetailRightBlock.Text       = version;
            DetailRightBlock.Visibility = Visibility.Visible;
        }
        else
        {
            DetailRightBlock.Visibility = Visibility.Collapsed;
        }

        ApplyColors();
    }

    private void ApplyColors()
    {
        var h         = IsHighlighted;
        var primary   = new SolidColorBrush(MenuItemHighlightColors.Primary(h));
        var secondary = new SolidColorBrush(MenuItemHighlightColors.Secondary(h));

        LeadingIcon.Foreground       = secondary;
        PrimaryNameBlock.Foreground  = primary;
        HeadlineRightBlock.Foreground = secondary;
        ChevronIcon.Foreground       = secondary;
        DetailLeftBlock.Foreground   = secondary;
        DetailRightBlock.Foreground  = secondary;
    }
}
