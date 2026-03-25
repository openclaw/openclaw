using Microsoft.UI.Xaml;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Settings;
using OpenClawWindows.Domain.ExecApprovals;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class GeneralSettingsViewModel : ObservableObject
{
    private readonly ISender _sender;
    private AppSettings? _current;

    // ── Core ─────────────────────────────────────────────────────────────────

    [ObservableProperty]
    private bool _isActive = true;

    [ObservableProperty]
    private bool _launchAtLogin;

    [ObservableProperty]
    private string _gatewayEndpointUri = string.Empty;

    // ── Connection mode ───────────────────────────────────────────────────────

    [ObservableProperty]
    private ConnectionMode _connectionMode;

    [ObservableProperty]
    private RemoteTransport _remoteTransport;

    [ObservableProperty]
    private string _remoteTarget = string.Empty;

    [ObservableProperty]
    private string _remoteUrl = string.Empty;

    [ObservableProperty]
    private string _remoteIdentity = string.Empty;

    [ObservableProperty]
    private string _remoteProjectRoot = string.Empty;

    [ObservableProperty]
    private string _remoteCliPath = string.Empty;

    // ── Voice wake ────────────────────────────────────────────────────────────

    [ObservableProperty]
    private bool _voiceWakeEnabled;

    [ObservableProperty]
    private float _voiceWakeSensitivity = 0.5f;

    // ── Feature toggles ───────────────────────────────────────────────────────

    [ObservableProperty]
    private bool _talkEnabled;

    [ObservableProperty]
    private bool _canvasEnabled;

    [ObservableProperty]
    private bool _peekabooBridgeEnabled;

    [ObservableProperty]
    private bool _heartbeatsEnabled;

    [ObservableProperty]
    private bool _debugPaneEnabled;

    // ── UI appearance ─────────────────────────────────────────────────────────

    [ObservableProperty]
    private bool _showDockIcon;

    [ObservableProperty]
    private bool _iconAnimationsEnabled;

    // ── Exec approvals ────────────────────────────────────────────────────────

    [ObservableProperty]
    private ExecApprovalMode _execApprovalMode;

    // ── Health status (read-only display) ─────────────────────────────────────

    [ObservableProperty]
    private string _healthStatus = string.Empty;

    // ── Tailscale sub-section ─────────────────────────────────────────────────

    public TailscaleSettingsViewModel Tailscale { get; }

    // ── ComboBox index shims (no XAML enum converters available) ─────────────

    // ConnectionMode: 0=Unconfigured, 1=Local, 2=Remote
    public int ConnectionModeIndex
    {
        get => (int)ConnectionMode;
        set { if ((int)ConnectionMode != value) { ConnectionMode = (ConnectionMode)value; OnPropertyChanged(); } }
    }

    // RemoteTransport: 0=Ssh, 1=Direct
    public int RemoteTransportIndex
    {
        get => (int)RemoteTransport;
        set { if ((int)RemoteTransport != value) { RemoteTransport = (RemoteTransport)value; OnPropertyChanged(); } }
    }

    // ExecApprovalMode: 0=Deny, 1=Ask, 2=Allow
    public int ExecApprovalModeIndex
    {
        get => (int)ExecApprovalMode;
        set { if ((int)ExecApprovalMode != value) { ExecApprovalMode = (ExecApprovalMode)value; OnPropertyChanged(); } }
    }

    // ── Derived visibility (no converters in App.xaml) ────────────────────────

    public Visibility RemoteSectionVisibility =>
        ConnectionMode == ConnectionMode.Remote ? Visibility.Visible : Visibility.Collapsed;

    public Visibility SshAdvancedVisibility =>
        ConnectionMode == ConnectionMode.Remote && RemoteTransport == RemoteTransport.Ssh
            ? Visibility.Visible : Visibility.Collapsed;

    public Visibility DirectUrlVisibility =>
        ConnectionMode == ConnectionMode.Remote && RemoteTransport == RemoteTransport.Direct
            ? Visibility.Visible : Visibility.Collapsed;

    // ── Partial change hooks ──────────────────────────────────────────────────

    partial void OnConnectionModeChanged(ConnectionMode value)
    {
        OnPropertyChanged(nameof(ConnectionModeIndex));
        OnPropertyChanged(nameof(RemoteSectionVisibility));
        OnPropertyChanged(nameof(SshAdvancedVisibility));
        OnPropertyChanged(nameof(DirectUrlVisibility));
    }

    partial void OnRemoteTransportChanged(RemoteTransport value)
    {
        OnPropertyChanged(nameof(RemoteTransportIndex));
        OnPropertyChanged(nameof(SshAdvancedVisibility));
        OnPropertyChanged(nameof(DirectUrlVisibility));
    }

    partial void OnExecApprovalModeChanged(ExecApprovalMode value) =>
        OnPropertyChanged(nameof(ExecApprovalModeIndex));

    // ─────────────────────────────────────────────────────────────────────────

    public GeneralSettingsViewModel(ISender sender, TailscaleSettingsViewModel tailscale)
    {
        _sender = sender;
        Tailscale = tailscale;
    }

    [RelayCommand]
    private async Task ToggleActiveAsync()
    {
        if (IsActive)
            await _sender.Send(new PauseGatewayCommand());
        else
            await _sender.Send(new ResumeGatewayCommand());
    }

    [RelayCommand]
    private async Task LoadAsync()
    {
        var result = await _sender.Send(new GetSettingsQuery());
        if (result.IsError) return;

        var s = result.Value;
        _current = s;

        LaunchAtLogin        = s.AutoStart;
        GatewayEndpointUri   = s.GatewayEndpointUri ?? string.Empty;
        VoiceWakeEnabled     = s.VoiceWakeEnabled;
        VoiceWakeSensitivity = s.VoiceWakeSensitivity;

        ConnectionMode    = s.ConnectionMode;
        RemoteTransport   = s.RemoteTransport;
        RemoteTarget      = s.RemoteTarget;
        RemoteUrl         = s.RemoteUrl;
        RemoteIdentity    = s.RemoteIdentity;
        RemoteProjectRoot = s.RemoteProjectRoot;
        RemoteCliPath     = s.RemoteCliPath;

        TalkEnabled           = s.TalkEnabled;
        CanvasEnabled         = s.CanvasEnabled;
        PeekabooBridgeEnabled = s.PeekabooBridgeEnabled;
        HeartbeatsEnabled     = s.HeartbeatsEnabled;
        DebugPaneEnabled      = s.DebugPaneEnabled;

        ShowDockIcon          = s.ShowDockIcon;
        IconAnimationsEnabled = s.IconAnimationsEnabled;

        ExecApprovalMode = s.ExecApprovalMode;
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        if (_current is null) return;

        _current.SetAutoStart(LaunchAtLogin);
        _current.SetGatewayEndpointUri(
            string.IsNullOrWhiteSpace(GatewayEndpointUri) ? null : GatewayEndpointUri);
        _current.SetVoiceWakeEnabled(VoiceWakeEnabled);
        _ = _current.SetVoiceWakeSensitivity(VoiceWakeSensitivity);

        _current.SetConnectionMode(ConnectionMode);
        _current.SetRemoteTransport(RemoteTransport);
        _current.SetRemoteTarget(RemoteTarget);
        _current.SetRemoteUrl(RemoteUrl);
        _current.SetRemoteIdentity(RemoteIdentity);
        _current.SetRemoteProjectRoot(RemoteProjectRoot);
        _current.SetRemoteCliPath(RemoteCliPath);

        _current.SetTalkEnabled(TalkEnabled);
        _current.SetCanvasEnabled(CanvasEnabled);
        _current.SetPeekabooBridgeEnabled(PeekabooBridgeEnabled);
        _current.SetHeartbeatsEnabled(HeartbeatsEnabled);
        _current.SetDebugPaneEnabled(DebugPaneEnabled);

        _current.SetShowDockIcon(ShowDockIcon);
        _current.SetIconAnimationsEnabled(IconAnimationsEnabled);

        _current.SetExecApprovalMode(ExecApprovalMode);

        await _sender.Send(new SaveSettingsCommand(_current));
    }
}
