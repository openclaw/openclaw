using Microsoft.UI;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace OpenClawWindows.Presentation.Components;

internal sealed partial class ContextUsageBar : UserControl
{
    public static readonly DependencyProperty UsedTokensProperty =
        DependencyProperty.Register(nameof(UsedTokens), typeof(int), typeof(ContextUsageBar),
            new PropertyMetadata(0, (d, _) => ((ContextUsageBar)d).ApplyState()));

    public static readonly DependencyProperty ContextTokensProperty =
        DependencyProperty.Register(nameof(ContextTokens), typeof(int), typeof(ContextUsageBar),
            new PropertyMetadata(0, (d, _) => ((ContextUsageBar)d).ApplyState()));

    public int UsedTokens
    {
        get => (int)GetValue(UsedTokensProperty);
        set => SetValue(UsedTokensProperty, value);
    }

    public int ContextTokens
    {
        get => (int)GetValue(ContextTokensProperty);
        set => SetValue(ContextTokensProperty, value);
    }

    public ContextUsageBar()
    {
        InitializeComponent();
        Loaded += (_, _) => { ApplyThemeColors(); ApplyState(); };
        ActualThemeChanged += (_, _) => ApplyThemeColors();
    }

    private void Root_SizeChanged(object sender, SizeChangedEventArgs e) => ApplyState();

    private void ApplyState()
    {
        var fraction = ContextUsageBarLogic.ComputeFraction(UsedTokens, ContextTokens);
        var pct      = ContextUsageBarLogic.ComputePercentUsed(UsedTokens, ContextTokens);
        var isDark   = ActualTheme == ElementTheme.Dark;

        Fill.Background = new SolidColorBrush(ContextUsageBarLogic.ComputeTintColor(pct, isDark));
        Fill.Width      = ContextUsageBarLogic.ComputeFillWidth(Root.ActualWidth, fraction);

        AutomationProperties.SetName(this,
            $"Context usage: {ContextUsageBarLogic.ComputeAccessibilityValue(UsedTokens, ContextTokens)}");
    }

    private void ApplyThemeColors()
    {
        var isDark      = ActualTheme == ElementTheme.Dark;
        var fillAlpha   = isDark ? ContextUsageBarLogic.TrackFillAlphaDark  : ContextUsageBarLogic.TrackFillAlphaLight;
        var strokeAlpha = isDark ? ContextUsageBarLogic.TrackStrokeAlphaDark : ContextUsageBarLogic.TrackStrokeAlphaLight;
        var baseColor   = isDark ? Colors.White : Colors.Black;

        Track.Background  = new SolidColorBrush(
            Color.FromArgb(fillAlpha,   baseColor.R, baseColor.G, baseColor.B));
        Track.BorderBrush = new SolidColorBrush(
            Color.FromArgb(strokeAlpha, baseColor.R, baseColor.G, baseColor.B));
    }
}
