using Windows.UI;
using WinUIApplication = Microsoft.UI.Xaml.Application;

namespace OpenClawWindows.Presentation.Onboarding;

/// <summary>Animated app icon with a pulsing glow ring, used on the onboarding screen.</summary>
internal sealed partial class GlowingOpenClawIcon : UserControl
{
    // Tunables
    internal const double DefaultSize          = 148;
    internal const double DefaultGlowIntensity = 0.35;
    internal const double GlowBlurRadius       = 18;
    internal const double GlowSizeBoost        = 56;    // added to icon size for glow canvas
    internal const double CornerRadiusFactor   = 0.22;  // applied as size * factor
    internal const double GlowOpacity          = 0.84;
    internal const double GlowScaleStart       = 0.96;  // glow scale: breathe off
    internal const double GlowScaleEnd         = 1.08;  // glow scale: breathe on
    internal const double IconScaleStart       = 1.00;  // icon scale: breathe off
    internal const double IconScaleEnd         = 1.02;  // icon scale: breathe on

    private bool _isLoaded;
    private bool _breathing;

    public static readonly DependencyProperty SizeProperty =
        DependencyProperty.Register(nameof(Size), typeof(double), typeof(GlowingOpenClawIcon),
            new PropertyMetadata(DefaultSize, (d, _) => ((GlowingOpenClawIcon)d).ApplyLayout()));

    public static readonly DependencyProperty GlowIntensityProperty =
        DependencyProperty.Register(nameof(GlowIntensity), typeof(double), typeof(GlowingOpenClawIcon),
            new PropertyMetadata(DefaultGlowIntensity, (d, _) => ((GlowingOpenClawIcon)d).ApplyGlowColors()));

    public static readonly DependencyProperty EnableFloatingProperty =
        DependencyProperty.Register(nameof(EnableFloating), typeof(bool), typeof(GlowingOpenClawIcon),
            new PropertyMetadata(true, (d, _) => ((GlowingOpenClawIcon)d).UpdateBreatheAnimation()));

    public double Size
    {
        get => (double)GetValue(SizeProperty);
        set => SetValue(SizeProperty, value);
    }

    public double GlowIntensity
    {
        get => (double)GetValue(GlowIntensityProperty);
        set => SetValue(GlowIntensityProperty, value);
    }

    public bool EnableFloating
    {
        get => (bool)GetValue(EnableFloatingProperty);
        set => SetValue(EnableFloatingProperty, value);
    }

    public GlowingOpenClawIcon()
    {
        InitializeComponent();
        Loaded   += OnLoaded;
        Unloaded += OnUnloaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        _isLoaded = true;
        ApplyLayout();
        ApplyGlowColors();
        UpdateBreatheAnimation();
    }

    private void OnUnloaded(object sender, RoutedEventArgs e)
    {
        _isLoaded = false;
        StopBreathe();
    }

    private void ApplyLayout()
    {
        if (!_isLoaded) return;

        var size         = Size;
        var glowCanvas   = ComputeGlowCanvasSize(size);
        var totalSize    = ComputeTotalSize(size);
        var cornerRadius = ComputeCornerRadius(size);

        Container.Width  = totalSize;
        Container.Height = totalSize;

        GlowEllipse.Width  = glowCanvas;
        GlowEllipse.Height = glowCanvas;

        IconBorder.Width        = size;
        IconBorder.Height       = size;
        IconBorder.CornerRadius = new CornerRadius(cornerRadius);

        IconImage.Width  = size;
        IconImage.Height = size;
    }

    private void ApplyGlowColors()
    {
        if (!_isLoaded) return;

        var intensity = GlowIntensity;
        var startAlpha = ComputeStartAlpha(intensity);
        var endAlpha   = ComputeEndAlpha(intensity);

        // accentColor.opacity(glowIntensity) → start stop using system accent
        var accent = GetAccentColor();
        GlowStartStop.Color = Color.FromArgb(startAlpha, accent.R, accent.G, accent.B);

        // Color.blue.opacity(glowIntensity * 0.6) → approximated as #1778FF
        GlowEndStop.Color = Color.FromArgb(endAlpha, 0x17, 0x78, 0xFF);
    }

    private void UpdateBreatheAnimation()
    {
        if (!_isLoaded) return;

        if (!EnableFloating)
        {
            StopBreathe();
            return;
        }

        if (_breathing) return;

        _breathing = true;
        BreatheStoryboard.Begin();
    }

    private void StopBreathe()
    {
        if (!_breathing) return;

        _breathing = false;
        BreatheStoryboard.Stop();

        // Reset transforms to resting state after stop
        GlowTransform.ScaleX = GlowScaleStart;
        GlowTransform.ScaleY = GlowScaleStart;
        IconTransform.ScaleX = IconScaleStart;
        IconTransform.ScaleY = IconScaleStart;
    }

    private static Color GetAccentColor()
    {
        try { return (Color)WinUIApplication.Current.Resources["SystemAccentColor"]; }
        catch { return Color.FromArgb(0xFF, 0x00, 0x78, 0xD4); }  // Windows blue fallback
    }

    // Pure geometry helpers — internal for tests
    internal static double ComputeGlowCanvasSize(double size) => size + GlowSizeBoost;
    internal static double ComputeTotalSize(double size) => ComputeGlowCanvasSize(size) + (GlowBlurRadius * 2);
    internal static double ComputeCornerRadius(double size) => size * CornerRadiusFactor;
    internal static byte   ComputeStartAlpha(double intensity) => (byte)(intensity * 255);
    internal static byte   ComputeEndAlpha(double intensity)   => (byte)(intensity * 0.6 * 255);
}
