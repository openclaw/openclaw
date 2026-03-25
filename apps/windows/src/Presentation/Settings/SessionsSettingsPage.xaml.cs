using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class SessionsSettingsPage : Page
{
    public SessionsSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        DataContext = e.Parameter as SessionsSettingsViewModel;
        if (DataContext is SessionsSettingsViewModel vm)
            _ = vm.RefreshCommand.ExecuteAsync(null);
    }
}
