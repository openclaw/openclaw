using System.Reflection;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.Updates;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class AboutSettingsViewModel : ObservableObject
{
    private readonly IUpdaterController _updater;

    public string AppVersion { get; } =
        Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "—";

    // WinUI 3 does not support Binding.StringFormat — expose pre-formatted string.
    public string VersionLabel => $"Version {AppVersion}";

    public string AppName => "OpenClaw";

    // Whether the platform updater is functional (false for dev/unsigned builds).
    public bool UpdaterAvailable => _updater.IsAvailable;

    // Bound to the "Update ready — restart now?" label in the tray menu.
    public bool IsUpdateReady => _updater.UpdateStatus.IsUpdateReady;

    // Human-readable update status line; null when no update is available.
    public string? UpdateStatus =>
        _updater.UpdateStatus.IsUpdateReady ? "Update available — restart to install." : null;

    [ObservableProperty]
    private bool _autoCheckEnabled;

    public AboutSettingsViewModel(IUpdaterController updater)
    {
        _updater = updater;

        // Mirror onAppear: sync the stored toggle into the updater on first load.
        _autoCheckEnabled = updater.AutomaticallyChecksForUpdates;
        updater.UpdateStatus.PropertyChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(IsUpdateReady));
            OnPropertyChanged(nameof(UpdateStatus));
        };
    }

    partial void OnAutoCheckEnabledChanged(bool value)
    {
        // Mirror onChange(of: autoCheckEnabled): push the new value into the updater.
        _updater.AutomaticallyChecksForUpdates = value;
        _updater.AutomaticallyDownloadsUpdates = value;
        UpdaterControllerFactory.SaveAutoUpdateSetting(value);
    }

    [RelayCommand]
    private void CheckForUpdates()
    {
        _updater.CheckForUpdates();
    }
}
