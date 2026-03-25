using OpenClawWindows.Application.Ports;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class CronSettingsPage : Page
{
    private CronSettingsViewModel? _vm;

    public CronSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        _vm = e.Parameter as CronSettingsViewModel;
        DataContext = _vm;
        if (_vm is not null)
            _ = _vm.RefreshCommand.ExecuteAsync(null);
    }

    // ── Toolbar ───────────────────────────────────────────────────────────────

    private async void OnAddJobClicked(object sender, RoutedEventArgs e)
    {
        if (_vm is null) return;
        await OpenEditorAsync(existingJob: null);
    }

    // ── Row actions ───────────────────────────────────────────────────────────

    private async void OnEditJobClicked(object sender, RoutedEventArgs e)
    {
        if (_vm is null) return;
        if (sender is not FrameworkElement { Tag: string jobId }) return;

        var fullJob = _vm.FindJob(jobId);
        if (fullJob is null) return;

        await OpenEditorAsync(existingJob: fullJob);
    }

    private async void OnRunJobClicked(object sender, RoutedEventArgs e)
    {
        if (_vm is null) return;
        if (sender is not FrameworkElement { Tag: string jobId }) return;
        await _vm.RunJobCommand.ExecuteAsync(jobId);
    }

    private async void OnDeleteJobClicked(object sender, RoutedEventArgs e)
    {
        if (_vm is null) return;
        if (sender is not FrameworkElement { Tag: string jobId }) return;
        await _vm.RemoveJobCommand.ExecuteAsync(jobId);
    }

    private async void OnToggleJobEnabled(object sender, RoutedEventArgs e)
    {
        if (_vm is null) return;
        // Tag is the full CronJobRow bound in the DataTemplate.
        if (sender is not FrameworkElement { Tag: CronSettingsViewModel.CronJobRow row }) return;
        await _vm.ToggleJobEnabledCommand.ExecuteAsync(row);
    }

    // ── Editor dialog ─────────────────────────────────────────────────────────

    private async Task OpenEditorAsync(GatewayCronJob? existingJob)
    {
        if (_vm is null || XamlRoot is null) return;

        var editorVm = new CronJobEditorViewModel(existingJob, _vm.ChannelStore);
        var dialog   = new CronJobEditorDialog(editorVm) { XamlRoot = XamlRoot };

        await dialog.ShowAsync();

        // Null result means the user cancelled.
        if (dialog.Result is not { } payload) return;

        await _vm.UpsertJobAsync(existingJob?.Id, payload);
    }
}
