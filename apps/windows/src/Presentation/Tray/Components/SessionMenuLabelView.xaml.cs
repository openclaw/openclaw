using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Domain.Sessions;
using Windows.UI;

namespace OpenClawWindows.Presentation.Tray.Components;

/// <summary>
/// Session row label for the tray menu.
/// </summary>
internal sealed partial class SessionMenuLabelView : UserControl
{
    // Tunables
    internal const double PaddingLeading  = 22;
    internal const double PaddingTrailing = 14;
    internal const double PaddingVertical = 10;
    internal const double Spacing         = 8;

    // ── Dependency properties ─────────────────────────────────────────────────

    // attempt to default-construct SessionRow (which has a required Key property).
    public static readonly DependencyProperty RowProperty =
        DependencyProperty.Register(nameof(Row), typeof(object), typeof(SessionMenuLabelView),
            new PropertyMetadata(null, (d, _) => ((SessionMenuLabelView)d).ApplyRow()));

    public static readonly DependencyProperty IsHighlightedProperty =
        DependencyProperty.Register(nameof(IsHighlighted), typeof(bool), typeof(SessionMenuLabelView),
            new PropertyMetadata(false, (d, _) => ((SessionMenuLabelView)d).ApplyColors()));

    // does not generate an activator for SessionRow (which has required Key).
    public object? Row
    {
        get => GetValue(RowProperty);
        set => SetValue(RowProperty, value);
    }

    public bool IsHighlighted
    {
        get => (bool)GetValue(IsHighlightedProperty);
        set => SetValue(IsHighlightedProperty, value);
    }

    public SessionMenuLabelView()
    {
        InitializeComponent();
        RootPanel.Padding = new Thickness(PaddingLeading, PaddingVertical, PaddingTrailing, PaddingVertical);
    }

    private void ApplyRow()
    {
        var row = Row as SessionRow;
        if (row is null) return;

        // ContextUsageBar
        UsageBar.UsedTokens    = row.TotalTokens;
        UsageBar.ContextTokens = row.ContextTokens;

        // Label — semibold if key == "main".
        LabelBlock.Text       = row.Label;
        LabelBlock.FontWeight = row.Key == "main"
            ? Microsoft.UI.Text.FontWeights.SemiBold
            : Microsoft.UI.Text.FontWeights.Normal;

        // Summary: "contextSummaryShort Â· ageText"
        SummaryBlock.Text = $"{row.ContextSummaryShort} Â· {row.AgeText}";

        ApplyColors();
    }

    private void ApplyColors()
    {
        var h       = IsHighlighted;
        var primary = new SolidColorBrush(MenuItemHighlightColors.Primary(h));
        var secondary = new SolidColorBrush(MenuItemHighlightColors.Secondary(h));

        LabelBlock.Foreground   = primary;
        SummaryBlock.Foreground = secondary;
        ChevronIcon.Foreground  = secondary;
    }
}
