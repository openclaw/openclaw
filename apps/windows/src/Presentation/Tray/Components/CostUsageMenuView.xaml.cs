using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using OpenClawWindows.Domain.Usage;
using Windows.UI;
using XamlCanvas = Microsoft.UI.Xaml.Controls.Canvas;

namespace OpenClawWindows.Presentation.Tray.Components;

// cost summary header, daily bar chart, optional partial footer.
//         (no chart library in the project; visual equivalence is maintained).
internal sealed partial class CostUsageMenuView : UserControl
{
    // Tunables
    private const double BarRadius   = 3;   // .cornerRadius(3)
    private const int    XAxisStride = 7;   // AxisMarks stride(by: .day, count: 7)

    // Chart layout — reserves space for Y-axis labels (left) and X-axis labels (bottom)
    private const double YAxisWidth  = 40;  // left margin for Y value labels
    private const double XAxisHeight = 14;  // bottom margin for X date labels

    // ── Dependency properties ──────────────────────────────────────────────────

    public static readonly DependencyProperty SummaryProperty =
        DependencyProperty.Register(nameof(Summary), typeof(GatewayCostUsageSummary), typeof(CostUsageMenuView),
            new PropertyMetadata(null, (d, _) => ((CostUsageMenuView)d).ApplySummary()));

    public static readonly DependencyProperty ContentWidthProperty =
        DependencyProperty.Register(nameof(ContentWidth), typeof(double), typeof(CostUsageMenuView),
            new PropertyMetadata(0.0, (d, _) => ((CostUsageMenuView)d).ApplySizing()));

    public GatewayCostUsageSummary? Summary
    {
        get => (GatewayCostUsageSummary?)GetValue(SummaryProperty);
        set => SetValue(SummaryProperty, value);
    }

    public double ContentWidth
    {
        get => (double)GetValue(ContentWidthProperty);
        set => SetValue(ContentWidthProperty, value);
    }

    public CostUsageMenuView()
    {
        InitializeComponent();
    }

    private void ApplySizing() => Width = Math.Max(1.0, ContentWidth);

    private void ChartCanvas_SizeChanged(object sender, SizeChangedEventArgs e) => RebuildChart();

    private void ApplySummary()
    {
        ApplyHeader();
        RebuildChart();
        ApplyFooter();
    }

    private void ApplyHeader()
    {
        var summary = Summary;
        if (summary == null) return;

        // todayKey lookup then FormatUsd with "n/a" fallback
        var todayKey   = CostUsageMenuDateParser.Format(DateTime.Now);
        var todayEntry = summary.Daily.FirstOrDefault(d => d.Date == todayKey);
        TodayCostBlock.Text  = CostUsageFormatting.FormatUsd(todayEntry?.TotalCost) ?? "n/a";
        RangeLabelBlock.Text = $"Last {summary.Days}d";
        TotalCostBlock.Text  = CostUsageFormatting.FormatUsd(summary.Totals.TotalCost) ?? "n/a";
    }

    private void RebuildChart()
    {
        ChartCanvas.Children.Clear();
        var summary = Summary;
        if (summary == null || summary.Daily.Count == 0) return;

        var canvasWidth = ChartCanvas.ActualWidth;
        if (canvasWidth <= 0) return;  // layout not yet available; SizeChanged will re-trigger

        // compactMap { entry -> (Date, Double)? }
        var entries = summary.Daily
            .Select(d => (Date: CostUsageMenuDateParser.Parse(d.Date), Cost: d.TotalCost))
            .Where(e => e.Date.HasValue)
            .Select(e => (Date: e.Date!.Value, e.Cost))
            .OrderBy(e => e.Date)
            .ToList();

        if (entries.Count == 0) return;

        var chartWidth  = canvasWidth - YAxisWidth;
        var chartHeight = 110 - XAxisHeight;  // matches .frame(height: 110)
        var maxCost     = entries.Max(e => e.Cost);
        if (maxCost <= 0) maxCost = 1;

        var isDark = ActualTheme == ElementTheme.Dark;

        // Three grid lines at 0%, 50%, 100% of max with cost labels on the left
        var gridBrush = new SolidColorBrush(isDark
            ? Color.FromArgb(0x33, 0xFF, 0xFF, 0xFF)
            : Color.FromArgb(0x33, 0x00, 0x00, 0x00));

        foreach (var fraction in new[] { 0.0, 0.5, 1.0 })
        {
            var lineY = chartHeight - fraction * chartHeight;

            var gridLine = new Rectangle { Width = chartWidth, Height = 0.5, Fill = gridBrush };
            XamlCanvas.SetLeft(gridLine, YAxisWidth);
            XamlCanvas.SetTop(gridLine, lineY);
            ChartCanvas.Children.Add(gridLine);

            var yLabel = new TextBlock
            {
                Text     = CostUsageFormatting.FormatUsd(fraction * maxCost) ?? "",
                FontSize = 9,
                Opacity  = 0.6
            };
            XamlCanvas.SetLeft(yLabel, 0);
            XamlCanvas.SetTop(yLabel, lineY - 7);
            ChartCanvas.Children.Add(yLabel);
        }

        // Draw bars
        var barSpacing = entries.Count > 1 ? 1.0 : 0.0;
        var barWidth   = Math.Max(1.0, (chartWidth - barSpacing * (entries.Count - 1)) / entries.Count);
        var accentBrush = (Brush)Resources["BarAccentBrush"];

        for (var i = 0; i < entries.Count; i++)
        {
            var (date, cost) = entries[i];
            var barHeight = Math.Max(1.0, cost / maxCost * chartHeight);
            var barX      = YAxisWidth + i * (barWidth + barSpacing);
            var barY      = chartHeight - barHeight;

            var bar = new Border
            {
                Width        = barWidth,
                Height       = barHeight,
                CornerRadius = new CornerRadius(BarRadius),
                Background   = accentBrush
            };
            XamlCanvas.SetLeft(bar, barX);
            XamlCanvas.SetTop(bar, barY);
            ChartCanvas.Children.Add(bar);

            if (i % XAxisStride == 0)
            {
                var xLabel = new TextBlock
                {
                    Text     = date.ToString("MMM d", CultureInfo.InvariantCulture),
                    FontSize = 9,
                    Opacity  = 0.6
                };
                XamlCanvas.SetLeft(xLabel, barX);
                XamlCanvas.SetTop(xLabel, chartHeight + 2);
                ChartCanvas.Children.Add(xLabel);
            }
        }
    }

    private void ApplyFooter()
    {
        var summary = Summary;
        if (summary == null || summary.Totals.MissingCostEntries == 0)
        {
            FooterBlock.Visibility = Visibility.Collapsed;
            return;
        }
        FooterBlock.Text       = $"Partial: {summary.Totals.MissingCostEntries} entries missing cost";
        FooterBlock.Visibility = Visibility.Visible;
    }
}

// Exposed as internal so date-parsing logic can be covered by unit tests.
internal static class CostUsageMenuDateParser
{
    private const string DateFormat = "yyyy-MM-dd";

    internal static DateTime? Parse(string value)
    {
        if (DateTime.TryParseExact(value, DateFormat, CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var date))
            return date;
        return null;
    }

    internal static string Format(DateTime date) =>
        date.ToString(DateFormat, CultureInfo.InvariantCulture);
}
