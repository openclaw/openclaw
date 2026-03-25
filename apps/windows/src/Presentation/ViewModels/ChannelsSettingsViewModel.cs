using System.Collections.ObjectModel;
using System.Text.Json;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class ChannelsSettingsViewModel : ObservableObject
{
    private readonly IChannelStore _channelStore;

    public ObservableCollection<ChannelItem> Channels { get; } = [];

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private string? _lastError;

    [ObservableProperty]
    private string? _lastRefreshed;

    public ChannelsSettingsViewModel(IChannelStore channelStore)
    {
        _channelStore = channelStore;
    }

    [RelayCommand]
    private Task RefreshAsync()
    {
        IsLoading = true;
        try
        {
            Channels.Clear();
            LastError = _channelStore.LastError;

            var at = _channelStore.LastSuccess;
            LastRefreshed = at.HasValue ? at.Value.ToLocalTime().ToString("HH:mm:ss") : null;

            var snapshot = _channelStore.StatusSnapshot;
            if (snapshot.HasValue)
                PopulateFromSnapshot(snapshot.Value);
        }
        finally
        {
            IsLoading = false;
        }

        return Task.CompletedTask;
    }

    private void PopulateFromSnapshot(JsonElement root)
    {
        // Parse channelOrder + per-channel status from the channels.status RPC response.
        // The gateway returns a ChannelsStatusSnapshot.
        if (!root.TryGetProperty("channelOrder", out var orderEl)) return;

        var channelLabels = root.TryGetProperty("channelLabels", out var labelsEl)
            ? labelsEl
            : (JsonElement?)null;
        var channelAccounts = root.TryGetProperty("channelAccounts", out var accountsEl)
            ? accountsEl
            : (JsonElement?)null;

        foreach (var idEl in orderEl.EnumerateArray())
        {
            var id = idEl.GetString() ?? "";
            if (string.IsNullOrEmpty(id)) continue;

            var label = channelLabels?.TryGetProperty(id, out var lEl) == true
                ? lEl.GetString() ?? id
                : id;

            // Determine connected state from the first account, if present.
            var isConnected = false;
            if (channelAccounts?.TryGetProperty(id, out var accsEl) == true)
            {
                foreach (var acc in accsEl.EnumerateArray())
                {
                    if (acc.TryGetProperty("connected", out var connEl) && connEl.GetBoolean())
                    {
                        isConnected = true;
                        break;
                    }
                }
            }

            var status = isConnected ? "Connected" : "Disconnected";
            Channels.Add(new ChannelItem(label, status, isConnected));
        }
    }

    public sealed record ChannelItem(string Name, string Status, bool IsConnected);
}
