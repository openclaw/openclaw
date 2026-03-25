using Microsoft.UI.Dispatching;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class DebugSettingsPage : Page
{
    public DebugSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        DataContext = e.Parameter as DebugSettingsViewModel;
        if (DataContext is DebugSettingsViewModel vm)
            vm.Initialize(DispatcherQueue.GetForCurrentThread());
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        if (DataContext is DebugSettingsViewModel vm)
            vm.Dispose();
    }
}
