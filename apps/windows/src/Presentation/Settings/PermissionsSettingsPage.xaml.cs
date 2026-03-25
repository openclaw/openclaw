using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class PermissionsSettingsPage : Page
{
    public PermissionsSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        DataContext = e.Parameter as PermissionsSettingsViewModel;
        if (DataContext is PermissionsSettingsViewModel vm)
            _ = vm.RefreshCommand.ExecuteAsync(null);
    }
}
