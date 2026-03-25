namespace OpenClawWindows.Presentation.Settings.Components;

internal sealed partial class SettingsSidebarScroll : UserControl
{
    // Tunables
    internal const double ContentPadding    = 10;
    internal const double MinWidthValue     = 220;
    internal const double IdealWidth        = 240;
    internal const double MaxWidthValue     = 280;
    internal const double CornerRadiusValue = 12;

    public static readonly DependencyProperty ScrollContentProperty =
        DependencyProperty.Register(nameof(ScrollContent), typeof(object), typeof(SettingsSidebarScroll),
            new PropertyMetadata(null));

    public object? ScrollContent
    {
        get => GetValue(ScrollContentProperty);
        set => SetValue(ScrollContentProperty, value);
    }

    public SettingsSidebarScroll()
    {
        InitializeComponent();
        Width = IdealWidth;
    }
}
