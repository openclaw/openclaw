using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class SkillsSettingsPage : Page
{
    private SkillsSettingsViewModel? _vm;

    // Guards against Toggled events that fire during binding/refresh rather than user interaction.
    private bool _suppressToggle;

    public SkillsSettingsPage()
    {
        InitializeComponent();
    }

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        _vm = e.Parameter as SkillsSettingsViewModel;
        DataContext = _vm;
        if (_vm is not null)
        {
            _suppressToggle = true;
            await _vm.RefreshCommand.ExecuteAsync(null);
            _suppressToggle = false;
        }
    }

    private async void OnSkillToggled(object sender, RoutedEventArgs e)
    {
        if (_suppressToggle || _vm is null) return;
        if (sender is not ToggleSwitch { Tag: SkillsSettingsViewModel.SkillItem item }) return;

        // Suppress re-entrant events while the command executes (command internally calls Refresh).
        _suppressToggle = true;
        try
        {
            await _vm.ToggleEnabledCommand.ExecuteAsync(item);
        }
        finally
        {
            _suppressToggle = false;
        }
    }
}
