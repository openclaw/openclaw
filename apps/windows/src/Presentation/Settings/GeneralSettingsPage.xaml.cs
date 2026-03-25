using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class GeneralSettingsPage : Page
{
    public GeneralSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        DataContext = e.Parameter as GeneralSettingsViewModel;
        if (DataContext is GeneralSettingsViewModel vm)
        {
            _ = vm.LoadCommand.ExecuteAsync(null);
            TailscaleSection.Bind(vm.Tailscale);
        }
    }
}
