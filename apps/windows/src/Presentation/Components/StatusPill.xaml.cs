using Microsoft.UI;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace OpenClawWindows.Presentation.Components;

internal sealed partial class StatusPill : UserControl
{
    // Tunables
    private const double HorizontalPadding = 7;
    private const double VerticalPadding   = 3;
    private const double FontSizeValue     = 10; // caption2 size
    private const byte   BackgroundAlpha   = 31; // 0.12 * 255 ≈ 31 (.opacity(0.12))

    public static readonly DependencyProperty TextProperty =
        DependencyProperty.Register(nameof(Text), typeof(string), typeof(StatusPill),
            new PropertyMetadata(string.Empty, (d, _) => ((StatusPill)d).ApplyText()));

    public static readonly DependencyProperty TintProperty =
        DependencyProperty.Register(nameof(Tint), typeof(SolidColorBrush), typeof(StatusPill),
            new PropertyMetadata(null, (d, _) => ((StatusPill)d).ApplyTint()));

    public string Text
    {
        get => (string)GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    public SolidColorBrush? Tint
    {
        get => (SolidColorBrush?)GetValue(TintProperty);
        set => SetValue(TintProperty, value);
    }

    public StatusPill()
    {
        InitializeComponent();
        Container.Padding = new Thickness(HorizontalPadding, VerticalPadding, HorizontalPadding, VerticalPadding);
        Label.FontSize = FontSizeValue;
    }

    private void ApplyText() => Label.Text = Text;

    private void ApplyTint()
    {
        if (Tint is not { } brush)
            return;

        Label.Foreground = brush;
        Container.Background = new SolidColorBrush(MakeBackgroundColor(brush.Color));
    }

    // Exposed as internal so tests can verify the alpha calculation without a WinRT host.
    internal static Color MakeBackgroundColor(Color tint) =>
        Color.FromArgb(BackgroundAlpha, tint.R, tint.G, tint.B);
}
