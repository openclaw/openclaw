using System.Collections.ObjectModel;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Instances;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class InstancesSettingsViewModel : ObservableObject
{
    private readonly IInstancesStore _store;

    public ObservableCollection<InstanceRow> Instances { get; } = [];

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private string? _statusMessage;

    public InstancesSettingsViewModel(IInstancesStore store)
    {
        _store = store;
        _store.InstancesChanged += OnStoreChanged;
        PopulateFromStore();
    }

    [RelayCommand]
    private void Refresh()
    {
        // Polling is driven by InstancesPollingHostedService; UI just reflects current state.
        PopulateFromStore();
    }

    private void OnStoreChanged(object? sender, EventArgs e)
    {
        // Marshal to UI thread — ViewModel may be subscribed from background polling task.
        var dispatcher = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
        if (dispatcher is not null)
            dispatcher.TryEnqueue(PopulateFromStore);
        else
            PopulateFromStore();
    }

    private void PopulateFromStore()
    {
        IsLoading = _store.IsLoading;
        StatusMessage = _store.LastError ?? _store.StatusMessage;

        Instances.Clear();
        foreach (var inst in _store.Instances)
            Instances.Add(InstanceRow.From(inst));
    }

    // Presentation-layer projection of InstanceInfo.
    public sealed record InstanceRow(
        string Id,
        string DisplayName,
        string? Platform,
        string? Mode,
        string AgeDescription,
        string LastInputDescription,
        bool IsActive)
    {
        public static InstanceRow From(InstanceInfo info)
        {
            // Active: presence beacon arrived within the last 120 seconds.
            var ageSeconds = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - (long)info.TsMs) / 1000L;
            return new(
                Id:                   info.Id,
                DisplayName:          info.Text,
                Platform:             info.Platform,
                Mode:                 info.Mode,
                AgeDescription:       info.AgeDescription,
                LastInputDescription: info.LastInputDescription,
                IsActive:             ageSeconds <= 120);
        }
    }
}
