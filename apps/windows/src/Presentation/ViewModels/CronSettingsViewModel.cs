using System.Collections.ObjectModel;
using OpenClawWindows.Application.Cron;
using OpenClawWindows.Application.Stores;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class CronSettingsViewModel : ObservableObject
{
    private readonly ISender _sender;
    private readonly ICronJobsStore _store;

    // Exposed so CronSettingsPage can pass it to CronJobEditorViewModel.
    internal IChannelStore ChannelStore { get; }

    public ObservableCollection<CronJobRow> CronJobs { get; } = [];

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private string? _lastError;

    [ObservableProperty]
    private string? _statusMessage;

    [ObservableProperty]
    private bool? _schedulerEnabled;

    public CronSettingsViewModel(ISender sender, ICronJobsStore store, IChannelStore channelStore)
    {
        _sender      = sender;
        _store       = store;
        ChannelStore = channelStore;
    }

    [RelayCommand]
    private Task RefreshAsync()
    {
        // Signal the polling service and populate from whatever the store currently has.
        _store.SignalRefresh();
        PopulateFromStore();
        return Task.CompletedTask;
    }

    [RelayCommand]
    private async Task RunJobAsync(string jobId)
    {
        var result = await _sender.Send(new RunCronJobCommand(jobId));
        if (result.IsError)
            LastError = result.FirstError.Description;
        else
            PopulateFromStore();
    }

    [RelayCommand]
    private async Task RemoveJobAsync(string jobId)
    {
        var result = await _sender.Send(new RemoveCronJobCommand(jobId));
        if (result.IsError)
            LastError = result.FirstError.Description;
        else
            PopulateFromStore();
    }

    [RelayCommand]
    private async Task ToggleJobEnabledAsync(CronJobRow row)
    {
        var result = await _sender.Send(new SetCronJobEnabledCommand(row.Id, !row.IsEnabled));
        if (result.IsError)
            LastError = result.FirstError.Description;
        else
            PopulateFromStore();
    }

    // Returns the full GatewayCronJob for the editor to hydrate from.
    internal GatewayCronJob? FindJob(string jobId)
        => _store.Jobs.FirstOrDefault(j => j.Id == jobId);

    public async Task UpsertJobAsync(string? jobId, Dictionary<string, object?> payload)
    {
        var result = await _sender.Send(new UpsertCronJobCommand(jobId, payload));
        if (result.IsError)
            LastError = result.FirstError.Description;
        else
            PopulateFromStore();
    }

    private void PopulateFromStore()
    {
        IsLoading        = _store.IsLoadingJobs;
        LastError        = _store.LastError;
        StatusMessage    = _store.StatusMessage;
        SchedulerEnabled = _store.SchedulerEnabled;

        CronJobs.Clear();
        foreach (var job in _store.Jobs)
            CronJobs.Add(CronJobRow.From(job));
    }

    // Property names match the existing XAML bindings (Name, Schedule, LastRun, IsEnabled).
    public sealed record CronJobRow(
        string Id,
        string Name,
        string Schedule,
        bool IsEnabled,
        string? LastRun)
    {
        // WinUI 3 does not support Binding.StringFormat — expose pre-formatted strings.
        public string LastRunLabel       => LastRun is not null ? $"Last: {LastRun}" : string.Empty;
        public string EnableDisableLabel => IsEnabled ? "Disable" : "Enable";

        internal static CronJobRow From(GatewayCronJob job)
        {
            // schedule.kind is the most compact meaningful label for the list view.
            var scheduleKind = job.Schedule.ValueKind == System.Text.Json.JsonValueKind.Object
                && job.Schedule.TryGetProperty("kind", out var k)
                    ? k.GetString() ?? "?"
                    : "?";

            var name = job.Name.Trim();
            if (string.IsNullOrEmpty(name)) name = "Untitled job";

            string? lastRun = null;
            if (job.State.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                if (job.State.TryGetProperty("lastStatus", out var ls))
                    lastRun = ls.GetString();
            }

            return new CronJobRow(job.Id, name, scheduleKind, job.Enabled, lastRun);
        }
    }
}
