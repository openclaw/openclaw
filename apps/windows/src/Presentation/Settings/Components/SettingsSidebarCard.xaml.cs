namespace OpenClawWindows.Presentation.Settings.Components;

/// <summary>
/// rounded card panel for the settings sidebar
/// with constrained width and window-background fill.
/// </summary>
internal sealed partial class SettingsSidebarCard : UserControl
{
    // Tunables
    internal const double MinWidthValue     = 220;
    internal const double IdealWidth        = 240;  // used as default Width
    internal const double MaxWidthValue     = 280;
    internal const double CornerRadiusValue = 12;

    public static readonly DependencyProperty CardContentProperty =
        DependencyProperty.Register(nameof(CardContent), typeof(object), typeof(SettingsSidebarCard),
            new PropertyMetadata(null));

    public object? CardContent
    {
        get => GetValue(CardContentProperty);
        set => SetValue(CardContentProperty, value);
    }

    public SettingsSidebarCard()
    {
        InitializeComponent();
        Width = IdealWidth;
    }
}
