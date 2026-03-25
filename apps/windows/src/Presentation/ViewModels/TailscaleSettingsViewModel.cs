using Windows.UI;
using OpenClawWindows.Application.Settings;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class TailscaleSettingsViewModel : ObservableObject
{
    private readonly ISender _sender;
    private readonly ITailscaleService _tailscale;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StatusText), nameof(StatusIndicatorColor),
        nameof(InstallButtonsVisibility), nameof(ModePickerVisibility),
        nameof(StartAppButtonVisibility), nameof(AccessUrlVisibility), nameof(TailscaleHintVisibility))]
    private bool _isInstalled;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StatusText), nameof(StatusIndicatorColor),
        nameof(StartAppButtonVisibility), nameof(AccessUrlVisibility), nameof(TailscaleHintVisibility))]
    private bool _isRunning;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AccessUrl), nameof(AccessUrlVisibility), nameof(TailscaleHintVisibility))]
    private string? _tailscaleHostname;

    [ObservableProperty]
    private string? _tailscaleIP;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TailscaleModeIndex), nameof(AccessUrlVisibility),
        nameof(ServeAuthVisibility), nameof(PasswordFieldVisibility),
        nameof(FunnelDescriptionVisibility), nameof(ServeNoCredHintVisibility),
        nameof(TailscaleHintVisibility))]
    private TailscaleMode _tailscaleMode = TailscaleMode.Off;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PasswordFieldVisibility), nameof(ServeNoCredHintVisibility))]
    private bool _requireCredentialsForServe;

    [ObservableProperty]
    private string _password = string.Empty;

    [ObservableProperty]
    private string? _statusMessage;

    [ObservableProperty]
    private string? _validationMessage;

    private bool _hasLoaded;

    public TailscaleSettingsViewModel(ISender sender, ITailscaleService tailscale)
    {
        _sender = sender;
        _tailscale = tailscale;
        _tailscale.IPChanged += (_, _) => SyncFromService();
    }

    // ── Derived display properties ────────────────────────────────────────────

    public string StatusText
    {
        get
        {
            if (!IsInstalled) return "Tailscale is not installed";
            if (IsRunning) return "Tailscale is installed and running";
            return "Tailscale is installed but not running";
        }
    }

    public Color StatusIndicatorColor
    {
        get
        {
            if (!IsInstalled) return Color.FromArgb(255, 234, 179, 8);  // yellow-500
            return IsRunning
                ? Color.FromArgb(255, 34, 197, 94)  // green-500
                : Color.FromArgb(255, 249, 115, 22); // orange-500
        }
    }

    // 0=Off, 1=Serve, 2=Funnel — maps TailscaleMode enum to ComboBox SelectedIndex
    public int TailscaleModeIndex
    {
        get => TailscaleMode switch
        {
            TailscaleMode.Serve => 1,
            TailscaleMode.Funnel => 2,
            _ => 0,
        };
        set
        {
            TailscaleMode = value switch
            {
                1 => TailscaleMode.Serve,
                2 => TailscaleMode.Funnel,
                _ => TailscaleMode.Off,
            };
        }
    }

    public string? AccessUrl => TailscaleHostname is { } h ? $"https://{h}/ui/" : null;

    // Visibility helpers — avoids converter boilerplate
    public Visibility InstallButtonsVisibility =>
        IsInstalled ? Visibility.Collapsed : Visibility.Visible;

    public Visibility ModePickerVisibility =>
        IsInstalled ? Visibility.Visible : Visibility.Collapsed;

    public Visibility StartAppButtonVisibility =>
        IsInstalled && !IsRunning && TailscaleMode != TailscaleMode.Off
            ? Visibility.Visible : Visibility.Collapsed;

    public Visibility AccessUrlVisibility =>
        TailscaleMode != TailscaleMode.Off && TailscaleHostname is not null
            ? Visibility.Visible : Visibility.Collapsed;

    public Visibility ServeAuthVisibility =>
        TailscaleMode == TailscaleMode.Serve ? Visibility.Visible : Visibility.Collapsed;

    public Visibility PasswordFieldVisibility =>
        TailscaleMode == TailscaleMode.Funnel
        || (TailscaleMode == TailscaleMode.Serve && RequireCredentialsForServe)
            ? Visibility.Visible : Visibility.Collapsed;

    public Visibility FunnelDescriptionVisibility =>
        TailscaleMode == TailscaleMode.Funnel ? Visibility.Visible : Visibility.Collapsed;

    public Visibility ServeNoCredHintVisibility =>
        TailscaleMode == TailscaleMode.Serve && !RequireCredentialsForServe
            ? Visibility.Visible : Visibility.Collapsed;

    public Visibility TailscaleHintVisibility =>
        TailscaleMode != TailscaleMode.Off && IsInstalled && !IsRunning && TailscaleHostname is null
            ? Visibility.Visible : Visibility.Collapsed;

    // ── Commands ──────────────────────────────────────────────────────────────

    [RelayCommand]
    private async Task LoadAsync()
    {
        await _tailscale.CheckStatusAsync();
        SyncFromService();

        var result = await _sender.Send(new GetSettingsQuery());
        if (result.IsError) return;

        var s = result.Value;
        TailscaleMode = s.TailscaleMode;
        RequireCredentialsForServe = s.TailscaleRequireCredentials;
        Password = s.TailscalePassword ?? string.Empty;
        _hasLoaded = true;
    }

    [RelayCommand]
    private async Task CheckStatusAsync()
    {
        await _tailscale.CheckStatusAsync();
        SyncFromService();
    }

    [RelayCommand]
    private async Task ApplySettingsAsync()
    {
        if (!_hasLoaded) return;
        ValidationMessage = null;
        StatusMessage = null;

        var trimmedPassword = Password.Trim();
        var requiresPassword = TailscaleMode == TailscaleMode.Funnel
            || (TailscaleMode == TailscaleMode.Serve && RequireCredentialsForServe);

        if (requiresPassword && string.IsNullOrEmpty(trimmedPassword))
        {
            ValidationMessage = "Password required for this mode.";
            return;
        }

        var result = await _sender.Send(new GetSettingsQuery());
        if (result.IsError) return;

        var s = result.Value;
        s.SetTailscaleMode(TailscaleMode);
        s.SetTailscaleRequireCredentials(RequireCredentialsForServe);
        s.SetTailscalePassword(trimmedPassword.Length > 0 ? trimmedPassword : null);

        var saveResult = await _sender.Send(new SaveSettingsCommand(s));
        StatusMessage = saveResult.IsError
            ? "Failed to save settings."
            : "Saved. Restart the gateway to apply.";
    }

    [RelayCommand]
    private void OpenTailscaleApp() => _tailscale.OpenTailscaleApp();

    [RelayCommand]
    private void OpenDownloadPage() => _tailscale.OpenDownloadPage();

    [RelayCommand]
    private void OpenSetupGuide() => _tailscale.OpenSetupGuide();

    // ── Internal ──────────────────────────────────────────────────────────────

    private void SyncFromService()
    {
        IsInstalled = _tailscale.IsInstalled;
        IsRunning = _tailscale.IsRunning;
        TailscaleHostname = _tailscale.TailscaleHostname;
        TailscaleIP = _tailscale.TailscaleIP;
    }
}
