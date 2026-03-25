using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class ChannelsSettingsPage : Page
{
    public ChannelsSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        DataContext = e.Parameter as ChannelsSettingsViewModel;
        if (DataContext is ChannelsSettingsViewModel vm)
            _ = vm.RefreshCommand.ExecuteAsync(null);
    }
}
