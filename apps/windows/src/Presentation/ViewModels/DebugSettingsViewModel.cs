using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Health;
using OpenClawWindows.Presentation.Windows;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class DebugSettingsViewModel : ObservableObject, IDisposable
{
    private readonly ISender            _sender;
    private readonly IHealthStore       _health;
    private readonly OnboardingViewModel _onboarding;
    private DispatcherQueue?            _queue;

    [ObservableProperty] private bool   _verboseLogging;
    [ObservableProperty] private string _logLevel = "info";

    // Health panel
    [ObservableProperty] private string  _healthSummaryLine  = "Health check pending";
    [ObservableProperty] private string  _healthStateBadge   = "—";
    [ObservableProperty] private string? _healthDetailLine;
    [ObservableProperty] private bool    _healthOk;

    public DebugSettingsViewModel(ISender sender, IHealthStore health, OnboardingViewModel onboarding)
    {
        _sender     = sender;
        _health     = health;
        _onboarding = onboarding;
    }

    // Called once from the View after DispatcherQueue is available.
    public void Initialize(DispatcherQueue queue)
    {
        _queue = queue;
        _health.HealthChanged += OnHealthChanged;
        RefreshFromStore();
    }

    private void OnHealthChanged(object? s, EventArgs e)
    {
        if (_queue is not null)
            _queue.TryEnqueue(RefreshFromStore);
        else
            RefreshFromStore();
    }

    private void RefreshFromStore()
    {
        HealthSummaryLine = _health.SummaryLine;
        HealthDetailLine  = BuildDetailLine(_health.LastError);

        switch (_health.State)
        {
            case HealthState.Ok:
                HealthStateBadge = "OK";
                HealthOk         = true;
                break;
            case HealthState.LinkingNeeded:
                HealthStateBadge = "Not Linked";
                HealthOk         = false;
                break;
            case HealthState.Degraded d:
                HealthStateBadge = $"Degraded";
                HealthDetailLine ??= d.Reason;
                HealthOk         = false;
                break;
            default:
                HealthStateBadge = "Unknown";
                HealthOk         = false;
                break;
        }
    }

    // maps gateway errors to human-friendly messages.
    private static string? BuildDetailLine(string? error)
    {
        if (string.IsNullOrEmpty(error)) return null;
        var lower = error.ToLowerInvariant();
        if (lower.Contains("connection refused"))
            return "The gateway control port isn't listening — restart OpenClaw to bring it back.";
        if (lower.Contains("timeout"))
            return "Timed out waiting for the control server; the gateway may be crashed or still starting.";
        return error;
    }

    [RelayCommand]
    private void OpenConfigFolder()
    {
        var configPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "OpenClaw");
        if (Directory.Exists(configPath))
            _ = global::Windows.System.Launcher.LaunchFolderPathAsync(configPath);
    }

    [RelayCommand]
    private void OpenLogFolder()
    {
        var logPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "OpenClaw", "logs");
        if (Directory.Exists(logPath))
            _ = global::Windows.System.Launcher.LaunchFolderPathAsync(logPath);
    }

    [RelayCommand]
    private async Task RestartOnboardingAsync()
    {
        await Task.CompletedTask;
    }

    public void Dispose()
    {
        _health.HealthChanged -= OnHealthChanged;
    }
}
