namespace OpenClawWindows.Presentation.Settings.Components;

internal sealed partial class SettingsRefreshButton : UserControl
{
    public static readonly DependencyProperty IsLoadingProperty =
        DependencyProperty.Register(nameof(IsLoading), typeof(bool), typeof(SettingsRefreshButton),
            new PropertyMetadata(false, (d, _) => ((SettingsRefreshButton)d).ApplyLoadingState()));

    public bool IsLoading
    {
        get => (bool)GetValue(IsLoadingProperty);
        set => SetValue(IsLoadingProperty, value);
    }

    public event RoutedEventHandler? Click;

    public SettingsRefreshButton()
    {
        InitializeComponent();
    }

    internal static Visibility SpinnerVisibility(bool isLoading) =>
        isLoading ? Visibility.Visible : Visibility.Collapsed;

    internal static Visibility ButtonVisibility(bool isLoading) =>
        isLoading ? Visibility.Collapsed : Visibility.Visible;

    private void ApplyLoadingState()
    {
        Spinner.Visibility = SpinnerVisibility(IsLoading);
        Spinner.IsActive    = IsLoading;
        RefreshBtn.Visibility = ButtonVisibility(IsLoading);
    }

    private void OnClick(object sender, RoutedEventArgs e) => Click?.Invoke(this, e);
}
