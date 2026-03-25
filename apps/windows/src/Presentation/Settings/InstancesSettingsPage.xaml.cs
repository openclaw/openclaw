using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class InstancesSettingsPage : Page
{
    public InstancesSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        DataContext = e.Parameter as InstancesSettingsViewModel;
        if (DataContext is InstancesSettingsViewModel vm)
            _ = (vm.RefreshCommand as CommunityToolkit.Mvvm.Input.IAsyncRelayCommand)?.ExecuteAsync(null);
    }
}
