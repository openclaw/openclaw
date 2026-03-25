using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Domain.Usage;

namespace OpenClawWindows.Presentation.Tray.Components;

/// <summary>
/// Usage row label for the tray menu.
/// </summary>
internal sealed partial class UsageMenuLabelView : UserControl
{
    // Tunables
    internal const double PaddingLeading  = 22;
    internal const double PaddingTrailing = 14;
    internal const double PaddingVertical = 10;
    internal const double Spacing         = 8;

    // ── Dependency properties ─────────────────────────────────────────────────

    // attempt to default-construct UsageRow (which has required init parameters).
    public static readonly DependencyProperty RowProperty =
        DependencyProperty.Register(nameof(Row), typeof(object), typeof(UsageMenuLabelView),
            new PropertyMetadata(null, (d, _) => ((UsageMenuLabelView)d).ApplyRow()));

    public static readonly DependencyProperty ShowsChevronProperty =
        DependencyProperty.Register(nameof(ShowsChevron), typeof(bool), typeof(UsageMenuLabelView),
            new PropertyMetadata(false, (d, _) => ((UsageMenuLabelView)d).ApplyChevronVisibility()));

    public static readonly DependencyProperty IsHighlightedProperty =
        DependencyProperty.Register(nameof(IsHighlighted), typeof(bool), typeof(UsageMenuLabelView),
            new PropertyMetadata(false, (d, _) => ((UsageMenuLabelView)d).ApplyColors()));

    public object? Row
    {
        get => GetValue(RowProperty);
        set => SetValue(RowProperty, value);
    }

    public bool ShowsChevron
    {
        get => (bool)GetValue(ShowsChevronProperty);
        set => SetValue(ShowsChevronProperty, value);
    }

    public bool IsHighlighted
    {
        get => (bool)GetValue(IsHighlightedProperty);
        set => SetValue(IsHighlightedProperty, value);
    }

    public UsageMenuLabelView()
    {
        InitializeComponent();
        RootPanel.Padding = new Thickness(PaddingLeading, PaddingVertical, PaddingTrailing, PaddingVertical);
    }

    private void ApplyRow()
    {
        var row = Row as UsageRow;
        if (row is null) return;

        // ContextUsageBar
        // usedTokens = Int(round(used)), contextTokens = 100
        if (row.UsedPercent.HasValue)
        {
            UsageBar.UsedTokens    = (int)Math.Round(row.UsedPercent.Value);
            UsageBar.ContextTokens = 100;
            UsageBar.Visibility    = Visibility.Visible;
        }
        else
        {
            UsageBar.Visibility = Visibility.Collapsed;
        }

        TitleBlock.Text  = row.TitleText;
        DetailBlock.Text = row.DetailText();

        ApplyColors();
    }

    private void ApplyChevronVisibility()
    {
        ChevronIcon.Visibility = ShowsChevron ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ApplyColors()
    {
        var h         = IsHighlighted;
        var primary   = new SolidColorBrush(MenuItemHighlightColors.Primary(h));
        var secondary = new SolidColorBrush(MenuItemHighlightColors.Secondary(h));

        TitleBlock.Foreground  = primary;
        DetailBlock.Foreground = secondary;
        ChevronIcon.Foreground = secondary;
    }
}
