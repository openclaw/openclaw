using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class AboutSettingsPage : Page
{
    public AboutSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        DataContext = e.Parameter as AboutSettingsViewModel;
    }
}
