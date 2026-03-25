namespace OpenClawWindows.Presentation.Settings.Components;

internal sealed partial class SettingsToggleRow : UserControl
{
    // Tunables
    internal const double VStackSpacing    = 6;
    internal const double SubtitleFontSize = 12;  // footnote size

    public static readonly DependencyProperty TitleProperty =
        DependencyProperty.Register(nameof(Title), typeof(string), typeof(SettingsToggleRow),
            new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty SubtitleProperty =
        DependencyProperty.Register(nameof(Subtitle), typeof(string), typeof(SettingsToggleRow),
            new PropertyMetadata(null, (d, _) => ((SettingsToggleRow)d).ApplySubtitle()));

    public static readonly DependencyProperty IsCheckedProperty =
        DependencyProperty.Register(nameof(IsChecked), typeof(bool), typeof(SettingsToggleRow),
            new PropertyMetadata(false, (d, e) => ((SettingsToggleRow)d).ApplyIsChecked()));

    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    public string? Subtitle
    {
        get => (string?)GetValue(SubtitleProperty);
        set => SetValue(SubtitleProperty, value);
    }

    public bool IsChecked
    {
        get => (bool)GetValue(IsCheckedProperty);
        set => SetValue(IsCheckedProperty, value);
    }

    public SettingsToggleRow()
    {
        InitializeComponent();
    }

    internal static Visibility SubtitleVisibility(string? subtitle) =>
        string.IsNullOrEmpty(subtitle) ? Visibility.Collapsed : Visibility.Visible;

    private void ApplySubtitle()
    {
        SubtitleText.Text       = Subtitle ?? string.Empty;
        SubtitleText.Visibility = SubtitleVisibility(Subtitle);
    }

    private void ApplyIsChecked()
    {
        ToggleCheck.IsChecked = IsChecked;
    }

    private void OnCheckedChanged(object sender, RoutedEventArgs e)
    {
        IsChecked = ToggleCheck.IsChecked == true;
    }
}
