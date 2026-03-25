using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.UI.Dispatching;
using NAudio.CoreAudioApi;
using OpenClawWindows.Application.Gateway;
using Serilog.Core;
using Serilog.Events;
using OpenClawWindows.Application.Lifecycle;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Sessions;
using OpenClawWindows.Application.Settings;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Domain.ExecApprovals;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Health;
using OpenClawWindows.Domain.Nodes;
using OpenClawWindows.Domain.Notifications;
using OpenClawWindows.Domain.Sessions;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Domain.Usage;
using OpenClawWindows.Domain.WorkActivity;
using OpenClawWindows.Presentation.Tray.Components;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;

namespace OpenClawWindows.Presentation.Tray;

/// <summary>
/// Drives the tray icon and context menu
/// Owns state for all toggles, health status, sessions list, and debug actions.
/// </summary>
internal sealed partial class SystemTrayViewModel : ObservableObject
{
    private readonly ISender _sender;
    private readonly IServiceProvider _sp;
    private readonly IUpdaterController _updater;
    private readonly IHealthStore _healthStore;
    private readonly IWorkActivityStore _activityStore;
    private readonly IWebChatManager _chatManager;
    private readonly IGatewayRpcChannel _rpc;
    private readonly IGatewayProcessManager _gatewayProcessManager;
    private readonly DispatcherQueue _dispatcherQueue;
    private readonly MenuSessionsInjector _menuSessionsInjector;
    private readonly MenuContextCardInjector _contextCardInjector;
    private readonly IHeartbeatStore _heartbeatStore;
    private readonly INodePairingPendingMonitor _nodePairing;
    private readonly IDevicePairingPendingMonitor _devicePairing;
    private readonly INodesStore _nodesStore;
    private readonly IVoiceWakeForwarder _voiceForwarder;
    private readonly INotificationProvider _notificationProvider;
    private readonly LoggingLevelSwitch _fileLevelSwitch;

    // Tunables
    private const int GatewayDashboardPort = 18789; // default local gateway HTTP port

    private AppSettings? _settings;

    // Window reuse — prevents duplicate Settings/AgentEvents windows (D-007, D-008).
    private SettingsWindow? _settingsWindow;
    private AgentEventsWindow? _agentEventsWindow;

    // ── Connection state ─────────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(GatewayStatusText))]
    [NotifyPropertyChangedFor(nameof(IsGatewayConnected))]
    private string _connectionStateLabel = "Disconnected";

    public string GatewayStatusText => ConnectionStateLabel switch
    {
        "Connected"      => "✅  Gateway connected",
        "Paused"         => "⏸  Gateway paused",
        "Reconnecting…"  => "🔄  Reconnecting…",
        "Voice Wake"     => "🎙  Voice wake active",
        _                => "⚪  Gateway disconnected",
    };

    // True only when the gateway WebSocket is connected — gates rich sections visibility.
    public bool IsGatewayConnected => ConnectionStateLabel == "Connected";

    [ObservableProperty]
    private string _connectionLabel = "OpenClaw Not Configured";

    [ObservableProperty]
    private string _gatewayDisplayName = string.Empty;

    [ObservableProperty]
    private bool _isPaused;

    // Negated IsPaused — IsChecked binding for the active/paused toggle.
    public bool IsActive => !IsPaused;

    [ObservableProperty]
    private string _trayIconPath = "ms-appx:///Assets/Icons/tray_disconnected.ico";

    [ObservableProperty]
    private ConnectionMode _connectionMode = ConnectionMode.Unconfigured;

    // ── Health status line ───────────────────────────────────────────────────

    [ObservableProperty]
    private string _healthStatusLabel = "Health pending";

    // "green" | "orange" | "red" | "blue" | "gray" — XAML DataTrigger picks the dot color.
    [ObservableProperty]
    private string _healthStatusColor = "gray";

    // ── Settings toggles (loaded once, saved per-change) ─────────────────────

    [ObservableProperty]
    private bool _heartbeatsEnabled;

    [ObservableProperty]
    private bool _cameraEnabled;

    [ObservableProperty]
    private bool _canvasEnabled;

    [ObservableProperty]
    private bool _voiceWakeEnabled;

    [ObservableProperty]
    private ExecApprovalMode _execApprovalMode = ExecApprovalMode.Ask;

    [ObservableProperty]
    private bool _talkEnabled;

    [ObservableProperty]
    private bool _debugPaneEnabled;

    // Debug: verbose logging for main gateway process.
    [ObservableProperty]
    private bool _verboseLoggingMain;

    // Debug: file logging enabled.
    [ObservableProperty]
    private bool _fileLoggingEnabled;

    // Browser control — loaded from gateway config.
    [ObservableProperty]
    private bool _browserControlEnabled = true;

    // Voice wake: SPIKE-004 pending — disabled until Porcupine hotword SDK is integrated.
    public bool IsVoiceWakeSupported => false;

    // Talk Mode uses WinRT SpeechRecognizer (STT) — works independently of voice wake hotword.
    public bool IsTalkModeSupported => true;

    // ── Heartbeat status line ─────────

    [ObservableProperty]
    private string _heartbeatStatusLabel = "No heartbeat yet";

    [ObservableProperty]
    private string _heartbeatStatusColor = "gray";

    // ── Pairing pending status lines ──────

    [ObservableProperty]
    private int _pairingPendingCount;

    [ObservableProperty]
    private int _pairingPendingRepairCount;

    [ObservableProperty]
    private int _devicePairingPendingCount;

    [ObservableProperty]
    private int _devicePairingPendingRepairCount;

    public string PairingStatusText
    {
        get
        {
            var suffix = PairingPendingRepairCount > 0 ? $" · {PairingPendingRepairCount} repair" : string.Empty;
            return $"Pairing approval pending ({PairingPendingCount}){suffix}";
        }
    }

    public string DevicePairingStatusText
    {
        get
        {
            var suffix = DevicePairingPendingRepairCount > 0 ? $" · {DevicePairingPendingRepairCount} repair" : string.Empty;
            return $"Device pairing pending ({DevicePairingPendingCount}){suffix}";
        }
    }

    // ── Nodes section ────────────────────────────────────────────────────────

    [ObservableProperty]
    private IReadOnlyList<NodeInfo> _nodes = [];

    [ObservableProperty]
    private bool _nodesIsLoading;

    // ── Mic picker (conditional on IsVoiceWakeSupported && VoiceWakeEnabled) ─

    public bool ShowMicPicker => IsVoiceWakeSupported && VoiceWakeEnabled;

    [ObservableProperty]
    private IReadOnlyList<AudioInputDeviceEntry> _availableMics = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(MicPickerLabel))]
    private string _selectedMicLabel = "System default";

    public string MicPickerLabel => $"Microphone: {SelectedMicLabel}";

    [ObservableProperty]
    private bool _isSelectedMicUnavailable;

    // ── Canvas panel visibility ──────────────────────────────────────────────

    [ObservableProperty]
    private bool _isCanvasPanelVisible;

    // ── Update ──────────────────────────────────────────────────────────────

    public bool IsUpdateReady => _updater.UpdateStatus.IsUpdateReady;

    // ── Sessions + usage/cost (populated by MenuSessionsInjector) ────────────

    public ObservableCollection<SessionRow> Sessions { get; } = [];

    public GatewayUsageSummary?      UsageSummary  { get; private set; }
    public GatewayCostUsageSummary?  CostSummary   { get; private set; }

    // Usage rows derived from UsageSummary (Fase 3 — usage section).
    public IReadOnlyList<UsageRow> UsageRows { get; private set; } = [];

    // HasCostSummary / HasUsageRows — bool gates for BoolToVisibilityConverter (no NullToVisibility).
    public bool HasCostSummary  => CostSummary is not null;
    public bool HasUsageRows    => UsageRows.Count > 0;
    public bool HasUsageOrCost  => HasUsageRows || HasCostSummary;

    // Integer count exposed for MenuUsageHeaderView.Count binding (IReadOnlyList is not observable).
    [ObservableProperty]
    private int _usageRowCount;

    // ── Context card (populated by MenuContextCardInjector) ──────────────────

    [ObservableProperty]
    private IReadOnlyList<SessionRow> _contextCardRows = [];

    [ObservableProperty]
    private string? _contextCardStatusText;

    [ObservableProperty]
    private bool _isContextCardLoading;

    // ── Derived labels ───────────────────────────────────────────────────────

    public string OpenCanvasLabel => IsCanvasPanelVisible ? "Close Canvas" : "Open Canvas";

    public string TalkModeLabel => TalkEnabled ? "Stop Talk Mode" : "Talk Mode";

    // Debug labels
    public string VerboseLoggingLabel => VerboseLoggingMain ? "Verbose Logging (Main): On" : "Verbose Logging (Main): Off";
    public string FileLoggingLabel => FileLoggingEnabled ? "File Logging: On" : "File Logging: Off";
    public bool IsRemoteMode => ConnectionMode == ConnectionMode.Remote;
    public bool IsLocalMode  => !IsRemoteMode;

    public string ExecApprovalTitle => ExecApprovalMode switch
    {
        ExecApprovalMode.Deny  => "Exec: Deny All",
        ExecApprovalMode.Ask   => "Exec: Ask",
        ExecApprovalMode.Allow => "Exec: Allow All",
        _                      => "Exec Approvals",
    };

    // Menu labels — emoji prefix for tray items (StringFormat unsupported in WinUI3 Binding).
    public string ExecApprovalMenu => $"✅  {ExecApprovalTitle}";
    public string OpenCanvasMenu   => $"🖼  {OpenCanvasLabel}";
    public string TalkModeMenu     => $"🗣  {TalkModeLabel}";

    // ── Constructor ─────────────────────────────────────────────────────────

    public SystemTrayViewModel(
        ISender sender,
        IServiceProvider sp,
        IUpdaterController updater,
        IHealthStore healthStore,
        IWorkActivityStore activityStore,
        IWebChatManager chatManager,
        IGatewayRpcChannel rpc,
        IGatewayProcessManager gatewayProcessManager,
        DispatcherQueue dispatcherQueue,
        MenuSessionsInjector menuSessionsInjector,
        MenuContextCardInjector contextCardInjector,
        IHeartbeatStore heartbeatStore,
        INodePairingPendingMonitor nodePairing,
        IDevicePairingPendingMonitor devicePairing,
        INodesStore nodesStore,
        IVoiceWakeForwarder voiceForwarder,
        INotificationProvider notificationProvider,
        LoggingLevelSwitch fileLevelSwitch)
    {
        _sender                = sender;
        _sp                    = sp;
        _updater               = updater;
        _healthStore           = healthStore;
        _activityStore         = activityStore;
        _chatManager           = chatManager;
        _rpc                   = rpc;
        _gatewayProcessManager = gatewayProcessManager;
        _dispatcherQueue       = dispatcherQueue;
        _menuSessionsInjector  = menuSessionsInjector;
        _contextCardInjector   = contextCardInjector;
        _heartbeatStore        = heartbeatStore;
        _nodePairing           = nodePairing;
        _devicePairing         = devicePairing;
        _nodesStore            = nodesStore;
        _voiceForwarder        = voiceForwarder;
        _notificationProvider  = notificationProvider;
        _fileLevelSwitch       = fileLevelSwitch;

        Helpers.SettingsWindowOpener.Shared.Register(OpenSettings);

        _updater.UpdateStatus.PropertyChanged += (_, _) => OnPropertyChanged(nameof(IsUpdateReady));
        _healthStore.HealthChanged   += (_, _) => _dispatcherQueue.TryEnqueue(RefreshHealthStatus);
        _activityStore.StateChanged  += (_, _) => _dispatcherQueue.TryEnqueue(RefreshHealthStatus);
        _nodePairing.Changed         += (_, _) => _dispatcherQueue.TryEnqueue(RefreshPairingStatus);
        _devicePairing.Changed       += (_, _) => _dispatcherQueue.TryEnqueue(RefreshPairingStatus);
        _nodesStore.NodesChanged     += (_, _) => _dispatcherQueue.TryEnqueue(RefreshNodes);
    }

    // ── Called by TrayIconPresenter ──────────────────────────────────────────

    internal void OnStateChanged(GatewayState state, string? activeSessionLabel)
    {
        IsPaused             = state == GatewayState.Paused;
        ConnectionStateLabel = ToStateLabel(state);
        TrayIconPath         = ToIconPath(state);

        OnPropertyChanged(nameof(IsActive));

        if (!string.IsNullOrWhiteSpace(activeSessionLabel))
            GatewayDisplayName = activeSessionLabel;

        RefreshHealthStatus();
    }

    // Called when the context menu window is about to appear — loads live data.
    internal async Task PrepareAsync(CancellationToken ct = default)
    {
        IsContextCardLoading = true;
        await LoadSettingsAsync(ct);
        await LoadBrowserControlAsync(ct);
        await LoadSessionsAsync(ct);
        var isConnected = ConnectionStateLabel == "Connected";
        await _menuSessionsInjector.OnMenuOpenedAsync(isConnected, ct);
        await _contextCardInjector.OnMenuOpenedAsync(ct);
        _dispatcherQueue.TryEnqueue(ApplyInjectorCache);
        _dispatcherQueue.TryEnqueue(ApplyContextCardCache);
        _dispatcherQueue.TryEnqueue(RefreshHeartbeatStatus);
        _dispatcherQueue.TryEnqueue(RefreshPairingStatus);
        _dispatcherQueue.TryEnqueue(RefreshNodes);
        if (ShowMicPicker)
            _ = LoadMicrophonesAsync(ct);
    }

    internal void OnMenuClosed()
    {
        _menuSessionsInjector.OnMenuClosed();
        _contextCardInjector.OnMenuClosed();
    }

    // ── Toggle commands ─────────────────────────────────────────────────────

    [RelayCommand]
    private async Task PauseResumeAsync()
    {
        if (IsPaused)
            await _sender.Send(new ResumeGatewayCommand());
        else
            await _sender.Send(new PauseGatewayCommand());
    }

    [RelayCommand]
    private async Task ToggleHeartbeatsAsync()
    {
        if (_settings is null) return;
        _settings.SetHeartbeatsEnabled(!HeartbeatsEnabled);
        HeartbeatsEnabled = _settings.HeartbeatsEnabled;
        await SaveSettingsAsync();
    }

    [RelayCommand]
    private async Task ToggleBrowserControlAsync()
    {
        var enabled = !BrowserControlEnabled;
        BrowserControlEnabled = enabled;
        await SaveBrowserControlAsync(enabled);
    }

    [RelayCommand]
    private async Task ToggleCameraAsync()
    {
        if (_settings is null) return;
        _settings.SetCameraEnabled(!CameraEnabled);
        CameraEnabled = _settings.CameraEnabled;
        await SaveSettingsAsync();
    }

    [RelayCommand]
    private async Task ToggleCanvasAsync()
    {
        if (_settings is null) return;
        _settings.SetCanvasEnabled(!CanvasEnabled);
        CanvasEnabled = _settings.CanvasEnabled;
        await SaveSettingsAsync();
    }

    [RelayCommand]
    private async Task ToggleVoiceWakeAsync()
    {
        if (_settings is null || !IsVoiceWakeSupported) return;
        _settings.SetVoiceWakeEnabled(!VoiceWakeEnabled);
        VoiceWakeEnabled = _settings.VoiceWakeEnabled;
        await SaveSettingsAsync();
    }

    // Sets the exec approval mode directly (used by the submenu picker items).
    [RelayCommand]
    private async Task SetExecApprovalModeAsync(string modeStr)
    {
        if (!Enum.TryParse<ExecApprovalMode>(modeStr, out var mode) || _settings is null) return;
        _settings.SetExecApprovalMode(mode);
        ExecApprovalMode = mode;
        OnPropertyChanged(nameof(ExecApprovalTitle));
        OnPropertyChanged(nameof(ExecApprovalMenu));
        await SaveSettingsAsync();
    }

    [RelayCommand]
    private async Task ToggleTalkModeAsync()
    {
        if (_settings is null) return;
        _settings.SetTalkEnabled(!TalkEnabled);
        TalkEnabled = _settings.TalkEnabled;
        OnPropertyChanged(nameof(TalkModeLabel));
        OnPropertyChanged(nameof(TalkModeMenu));
        await SaveSettingsAsync();
    }

    // ── Action commands ─────────────────────────────────────────────────────

    [RelayCommand]
    private async Task OpenDashboardAsync()
    {
        try
        {
            var settings = _settings ?? await LoadSettingsAsync();
            var url      = BuildDashboardUrl(settings);
            Process.Start(new ProcessStartInfo(url.ToString()) { UseShellExecute = true });
        }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private async Task OpenChatAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var sessionKey = await _chatManager.GetPreferredSessionKeyAsync(cts.Token);
            await _chatManager.ShowAsync(sessionKey);
        }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private async Task ToggleCanvasPanelAsync()
    {
        var canvas = _sp.GetService<IWebView2Host>();
        if (canvas is null) return;

        if (IsCanvasPanelVisible)
        {
            await canvas.HideAsync(CancellationToken.None);
            IsCanvasPanelVisible = false;
            OnPropertyChanged(nameof(OpenCanvasLabel));
            OnPropertyChanged(nameof(OpenCanvasMenu));
        }
        else
        {
            // Uses canvasHostUrl from hello-ok snapshot (e.g. http://127.0.0.1:18789)
            // and navigates to the A2UI endpoint with auth token.
            var url = BuildCanvasA2UIUrl();
            var paramsResult = Domain.Canvas.CanvasPresentParams.FromJson($"{{\"url\":\"{url}\",\"pin\":false}}");
            if (paramsResult.IsError) return;
            await canvas.PresentAsync(paramsResult.Value, CancellationToken.None);
            IsCanvasPanelVisible = true;
            OnPropertyChanged(nameof(OpenCanvasLabel));
            OnPropertyChanged(nameof(OpenCanvasMenu));
        }
    }

    [RelayCommand]
    private void OpenSettings()
    {
        if (_settingsWindow is null)
        {
            var vm = _sp.GetRequiredService<SettingsViewModel>();
            _settingsWindow = new SettingsWindow(vm);
            _settingsWindow.Closed += (_, _) => _settingsWindow = null;
        }
        _settingsWindow.Activate();
    }

    [RelayCommand]
    private void OpenAbout()
    {
        // Opens Settings window; the About tab is selected via navigation in SettingsWindow.
        OpenSettings();
    }

    [RelayCommand]
    private void ApplyUpdate() => _updater.CheckForUpdates();

    [RelayCommand]
    private async Task QuitAsync()
    {
        try
        {
            await _sender.Send(new QuitApplicationCommand());
        }
        finally
        {
            // StopApplication() stops the host but does not exit the WinUI app loop.
            // Force-exit via the XAML Application to ensure the process terminates.
            Microsoft.UI.Xaml.Application.Current.Exit();
        }
    }

    // ── Debug commands (mirror DebugActions in macOS) ────────────────────────

    [RelayCommand]
    private void OpenAgentEvents()
    {
        if (_agentEventsWindow is null)
        {
            _agentEventsWindow = new AgentEventsWindow(_sp.GetRequiredService<AgentEventsViewModel>());
            _agentEventsWindow.Closed += (_, _) => _agentEventsWindow = null;
        }
        _agentEventsWindow.Activate();
    }

    [RelayCommand]
    private void OpenConfigFolder()
    {
        var path = _settings?.AppDataPath
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OpenClaw");
        try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private async Task RunHealthCheckNowAsync()
    {
        _healthStore.SetRefreshing(true);
        try
        {
            var data = await _rpc.RequestRawAsync("health", null, 15_000);
            if (data.Length > 0)
            {
                // Re-use the existing HealthPollingHostedService decode path via shared IHealthStore.
                // We fire the raw health event — the store state consumers (tray icon, etc.) react.
                var snap = TryDecodeHealthSnapshot(data);
                if (snap is not null)
                    _healthStore.Apply(snap);
                else
                    _healthStore.SetError("health output not JSON");
            }
        }
        catch (Exception ex)
        {
            _healthStore.SetError(ex.Message);
        }
    }

    [RelayCommand]
    private void OpenLog()
    {
        var logDir  = Path.Combine(
            _settings?.AppDataPath
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OpenClaw"),
            "logs");
        var logFile = Directory.EnumerateFiles(logDir, "openclaw-*.log")
            .OrderByDescending(f => f)
            .FirstOrDefault();

        if (logFile is null) return;
        try { Process.Start(new ProcessStartInfo(logFile) { UseShellExecute = true }); }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private void RestartGateway()
    {
        _gatewayProcessManager.SetActive(false);
        _gatewayProcessManager.SetActive(true);
    }

    [RelayCommand]
    private void RestartApp()
    {
        var exe = Process.GetCurrentProcess().MainModule?.FileName;
        if (exe is not null)
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
        Microsoft.UI.Xaml.Application.Current.Exit();
    }

    [RelayCommand]
    private async Task SendTestHeartbeatAsync()
    {
        try
        {
            await _rpc.SetHeartbeatsAsync(true);
            // Re-fetch initial heartbeat from gateway to update the store.
            await _heartbeatStore.TryFetchInitialAsync(_rpc);
            _dispatcherQueue.TryEnqueue(RefreshHeartbeatStatus);
        }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private async Task ToggleVerboseLoggingMainAsync()
    {
        VerboseLoggingMain = !VerboseLoggingMain;
        OnPropertyChanged(nameof(VerboseLoggingLabel));
        try
        {
            var eventName = VerboseLoggingMain ? "verbose-main:on" : "verbose-main:off";
            await _rpc.SendSystemEventAsync(new Dictionary<string, object?> { ["event"] = eventName });
        }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private void ToggleFileLogging()
    {
        FileLoggingEnabled = !FileLoggingEnabled;
        OnPropertyChanged(nameof(FileLoggingLabel));
        // Drive the Serilog file sink level switch registered in App.xaml.cs.
        // (LogEventLevel)int.MaxValue is above Fatal — effectively disables the sink.
        _fileLevelSwitch.MinimumLevel = FileLoggingEnabled
            ? LogEventLevel.Information
            : (LogEventLevel)int.MaxValue;
    }

    [RelayCommand]
    private void OpenSessionStore()
    {
        var sessionsPath = Path.Combine(
            _settings?.AppDataPath
                ?? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData) + "\\OpenClaw",
            "sessions");

        if (!Directory.Exists(sessionsPath))
            Directory.CreateDirectory(sessionsPath);

        try { Process.Start(new ProcessStartInfo(sessionsPath) { UseShellExecute = true }); }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private async Task SendDebugVoiceAsync()
    {
        try
        {
            await _voiceForwarder.ForwardAsync("Debug voice test from tray menu");
        }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private async Task SendTestNotificationAsync()
    {
        var request = ToastNotificationRequest.Create(
            "OpenClaw", "Test notification from debug menu", null, null, null);
        if (request.IsError) return;
        try
        {
            await _notificationProvider.ShowAsync(request.Value, CancellationToken.None);
        }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    private async Task RestartOnboardingAsync()
    {
        if (_settings is null) return;
        _settings.SetOnboardingSeen(false);
        await SaveSettingsAsync();
    }

    [RelayCommand]
    private async Task OpenSessionChatAsync(string sessionKey)
    {
        await _chatManager.ShowAsync(sessionKey);
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private async Task<AppSettings> LoadSettingsAsync(CancellationToken ct = default)
    {
        var result = await _sender.Send(new GetSettingsQuery(), ct);
        if (result.IsError)
        {
            return _settings ?? AppSettings.WithDefaults(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OpenClaw"));
        }

        _settings = result.Value;
        ApplySettingsToProperties(_settings);
        return _settings;
    }

    private void ApplySettingsToProperties(AppSettings s)
    {
        HeartbeatsEnabled = s.HeartbeatsEnabled;
        CameraEnabled     = s.CameraEnabled;
        CanvasEnabled     = s.CanvasEnabled;
        VoiceWakeEnabled  = s.VoiceWakeEnabled;
        ExecApprovalMode  = s.ExecApprovalMode;
        TalkEnabled       = s.TalkEnabled;
        DebugPaneEnabled  = s.DebugPaneEnabled;
        ConnectionMode    = s.ConnectionMode;
        ConnectionLabel   = s.ConnectionMode switch
        {
            ConnectionMode.Unconfigured => "OpenClaw",
            ConnectionMode.Remote       => "Remote OpenClaw",
            _                           => "OpenClaw",
        };

        OnPropertyChanged(nameof(ExecApprovalTitle));
        OnPropertyChanged(nameof(ExecApprovalMenu));
        OnPropertyChanged(nameof(TalkModeLabel));
        OnPropertyChanged(nameof(TalkModeMenu));
    }

    private async Task SaveSettingsAsync()
    {
        if (_settings is null) return;
        await _sender.Send(new SaveSettingsCommand(_settings));
    }

    private async Task LoadBrowserControlAsync(CancellationToken ct = default)
    {
        // reads browser.enabled from the gateway config (ConfigStore.load()).
        try
        {
            var raw    = await _rpc.ConfigGetAsync(ct: ct);
            using var doc = JsonDocument.Parse(raw);
            var enabled = doc.RootElement
                .TryGetProperty("browser", out var browser)
                && browser.TryGetProperty("enabled", out var val)
                && val.ValueKind == JsonValueKind.True;

            // Treat absent browser.enabled as true (macOS default).
            BrowserControlEnabled = !doc.RootElement.TryGetProperty("browser", out _) || enabled;
        }
        catch { /* gateway offline — keep current value */ }
    }

    private async Task SaveBrowserControlAsync(bool enabled)
    {
        // patches browser.enabled in the gateway config via config.set RPC.
        try
        {
            var raw  = await _rpc.ConfigGetAsync();
            using var doc  = JsonDocument.Parse(raw);
            var root = JsonSerializer.Deserialize<Dictionary<string, object?>>(raw)
                       ?? new Dictionary<string, object?>();

            var browser = root.TryGetValue("browser", out var b) && b is Dictionary<string, object?> bd
                ? bd
                : new Dictionary<string, object?>();
            browser["enabled"] = enabled;
            root["browser"]    = browser;

            await _rpc.ConfigSetAsync(root);
        }
        catch
        {
            // Roll back the UI toggle if the save failed.
            _dispatcherQueue.TryEnqueue(() => BrowserControlEnabled = !enabled);
        }
    }

    private async Task LoadSessionsAsync(CancellationToken ct = default)
    {
        // best-effort, gateway may be offline.
        try
        {
            var result = await _sender.Send(new ListSessionsQuery(), ct);
            if (result.IsError) return;

            _dispatcherQueue.TryEnqueue(() =>
            {
                Sessions.Clear();
                foreach (var row in result.Value.Rows)
                    Sessions.Add(row);
            });
        }
        catch { /* sessions are best-effort */ }
    }

    private void ApplyInjectorCache()
    {
        UsageSummary  = _menuSessionsInjector.CachedUsageSummary;
        CostSummary   = _menuSessionsInjector.CachedCostSummary;
        UsageRows     = SortUsageRowsBySelectedProvider(
                            UsageSummary?.PrimaryRows() ?? [],
                            _menuSessionsInjector.CachedDefaultModel);
        UsageRowCount = UsageRows.Count;
        OnPropertyChanged(nameof(UsageSummary));
        OnPropertyChanged(nameof(CostSummary));
        OnPropertyChanged(nameof(UsageRows));
        OnPropertyChanged(nameof(HasUsageRows));
        OnPropertyChanged(nameof(HasCostSummary));
        OnPropertyChanged(nameof(HasUsageOrCost));
    }

    // when multiple providers are present, the provider matching the current model is sorted first.
    private static IReadOnlyList<UsageRow> SortUsageRowsBySelectedProvider(
        IReadOnlyList<UsageRow> rows, string? defaultModel)
    {
        if (rows.Count <= 1) return rows;
        var selectedId = ExtractUsageProviderId(defaultModel);
        if (selectedId is null) return rows;
        var primary = rows.FirstOrDefault(
            r => r.ProviderId.Equals(selectedId, StringComparison.OrdinalIgnoreCase));
        if (primary is null) return rows;
        var sorted = new List<UsageRow>(rows.Count) { primary };
        sorted.AddRange(rows.Where(r => r.ProviderId != primary.ProviderId));
        return sorted;
    }

    // Extracts the provider prefix from a "{provider}/{model}" string.
    private static string? ExtractUsageProviderId(string? model)
    {
        if (string.IsNullOrWhiteSpace(model)) return null;
        var slash = model.IndexOf('/');
        if (slash <= 0) return null;
        var provider = model[..slash].Trim().ToLowerInvariant();
        return string.IsNullOrEmpty(provider) ? null : provider;
    }

    private void ApplyContextCardCache()
    {
        ContextCardRows       = _contextCardInjector.CachedRows;
        ContextCardStatusText = _contextCardInjector.CacheErrorText;
        IsContextCardLoading  = false;
        OnPropertyChanged(nameof(ContextCardRows));
        OnPropertyChanged(nameof(ContextCardStatusText));
    }

    private void RefreshHealthStatus()
    {
        var activity = _activityStore.Current;
        if (activity is not null)
        {
            var roleLabel = activity.Role == SessionRole.Main ? "Main" : "Other";
            HealthStatusLabel = $"{roleLabel} · {activity.Label}";
            HealthStatusColor = activity.Role == SessionRole.Main ? "blue" : "gray";
            return;
        }

        var health      = _healthStore.State;
        var isRefreshing = _healthStore.IsRefreshing;
        var lastAge     = _healthStore.LastSuccess.HasValue ? AgeText(_healthStore.LastSuccess.Value) : null;

        if (isRefreshing)
        {
            HealthStatusLabel = "Health check running…";
            HealthStatusColor = "gray";
            return;
        }

        switch (health)
        {
            case HealthState.Ok:
                var ageOk = lastAge is not null ? $" · checked {lastAge}" : string.Empty;
                HealthStatusLabel = $"Health ok{ageOk}";
                HealthStatusColor = "green";
                break;

            case HealthState.LinkingNeeded:
                HealthStatusLabel = "Health: login required";
                HealthStatusColor = "red";
                break;

            case HealthState.Degraded deg:
                var detail   = _healthStore.DegradedSummary ?? deg.Reason;
                var ageDeg   = lastAge is not null ? $" · checked {lastAge}" : string.Empty;
                HealthStatusLabel = $"{detail}{ageDeg}";
                HealthStatusColor = "orange";
                break;

            case HealthState.Unknown:
                // Snapshot arrived but no channel has Linked=true — user must run openclaw login.
                if (_healthStore.Snapshot is not null)
                {
                    HealthStatusLabel = "Not linked";
                    HealthStatusColor = "orange";
                }
                else
                {
                    HealthStatusLabel = "Health pending";
                    HealthStatusColor = "gray";
                }
                break;

            default:
                HealthStatusLabel = "Health pending";
                HealthStatusColor = "gray";
                break;
        }
    }

    private void RefreshHeartbeatStatus()
    {
        var evt = _heartbeatStore.LastEvent;
        if (evt is null)
        {
            HeartbeatStatusLabel = "No heartbeat yet";
            HeartbeatStatusColor = "gray";
            return;
        }

        var ageText = AgeText(DateTimeOffset.FromUnixTimeMilliseconds((long)evt.Ts));
        (HeartbeatStatusLabel, HeartbeatStatusColor) = evt.Status switch
        {
            "sent"                  => ($"Last heartbeat sent · {ageText}", "blue"),
            "ok-empty" or "ok-token" => ($"Heartbeat ok · {ageText}", "green"),
            "skipped"               => ($"Heartbeat skipped · {ageText}", "gray"),
            "failed"                => ($"Heartbeat failed · {ageText}", "red"),
            _                       => ($"Heartbeat · {ageText}", "gray"),
        };
    }

    private void RefreshPairingStatus()
    {
        PairingPendingCount        = _nodePairing.PendingCount;
        PairingPendingRepairCount  = _nodePairing.PendingRepairCount;
        DevicePairingPendingCount       = _devicePairing.PendingCount;
        DevicePairingPendingRepairCount = _devicePairing.PendingRepairCount;
        OnPropertyChanged(nameof(PairingStatusText));
        OnPropertyChanged(nameof(DevicePairingStatusText));
    }

    private void RefreshNodes()
    {
        Nodes         = _nodesStore.Nodes;
        NodesIsLoading = _nodesStore.IsLoading;
    }

    // ── Mic picker commands ─────────────

    [RelayCommand]
    private void SetDefaultMic()
    {
        if (_settings is null) return;
        _settings.SetVoiceWakeMicId(string.Empty);
        _settings.SetVoiceWakeMicName(string.Empty);
        _ = SaveSettingsAsync();
        UpdateSelectedMicLabel();
    }

    [RelayCommand]
    private void SetMic(string micId)
    {
        if (_settings is null) return;
        var match = AvailableMics.FirstOrDefault(m => m.Uid == micId);
        if (match is null) return;
        _settings.SetVoiceWakeMicId(match.Uid);
        _settings.SetVoiceWakeMicName(match.Name);
        _ = SaveSettingsAsync();
        UpdateSelectedMicLabel();
    }

    // Returns immediately when ShowMicPicker is false (i.e. voice wake not supported).
    private async Task LoadMicrophonesAsync(CancellationToken ct = default)
    {
        if (!ShowMicPicker)
        {
            AvailableMics = [];
            return;
        }

        await Task.Run(() =>
        {
            try
            {
                using var enumerator = new MMDeviceEnumerator();
                var devices = enumerator
                    .EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
                    .OrderBy(d => d.FriendlyName, StringComparer.OrdinalIgnoreCase)
                    .Select(d => new AudioInputDeviceEntry(d.ID, d.FriendlyName))
                    .ToList();

                _dispatcherQueue.TryEnqueue(() =>
                {
                    AvailableMics = devices;
                    UpdateSelectedMicLabel();
                });
            }
            catch { /* device enumeration is best-effort */ }
        }, ct).ConfigureAwait(false);
    }

    private void UpdateSelectedMicLabel()
    {
        var micId = _settings?.VoiceWakeMicId ?? string.Empty;
        if (string.IsNullOrEmpty(micId))
        {
            SelectedMicLabel      = "System default";
            IsSelectedMicUnavailable = false;
            return;
        }

        var match = AvailableMics.FirstOrDefault(m => m.Uid == micId);
        if (match is not null)
        {
            SelectedMicLabel      = match.Name;
            IsSelectedMicUnavailable = false;
            return;
        }

        var savedName = _settings?.VoiceWakeMicName;
        SelectedMicLabel      = !string.IsNullOrEmpty(savedName) ? savedName : "Unavailable";
        IsSelectedMicUnavailable = true;
    }

    private static string AgeText(DateTimeOffset ts)
    {
        var delta   = DateTimeOffset.UtcNow - ts;
        var minutes = (int)Math.Round(delta.TotalMinutes);
        if (minutes < 1)  return "just now";
        if (minutes < 60) return $"{minutes}m";
        var hours = (int)Math.Round(delta.TotalHours);
        if (hours < 48)   return $"{hours}h";
        return $"{(int)Math.Round(delta.TotalDays)}d";
    }

    // Injects the gateway token as a URL fragment (#token=xxx) so the dashboard auto-authenticates.
    private static Uri BuildDashboardUrl(AppSettings settings)
    {
        string rawUri;
        if (settings.ConnectionMode == ConnectionMode.Remote && !string.IsNullOrWhiteSpace(settings.RemoteUrl))
            rawUri = settings.RemoteUrl;
        else
            rawUri = settings.GatewayEndpointUri ?? $"ws://127.0.0.1:{GatewayDashboardPort}";

        // Extract token from ws://TOKEN@host:port URI if present
        string? token = null;
        if (Uri.TryCreate(rawUri, UriKind.Absolute, out var parsed) && !string.IsNullOrEmpty(parsed.UserInfo))
            token = parsed.UserInfo;

        // Fallback: read token from ~/.openclaw/openclaw.json (same source as bootstrap).
        // GatewayEndpointUri may be null when settings were loaded from the gateway RPC
        // (which doesn't carry local-only fields).
        if (string.IsNullOrEmpty(token))
            token = TryReadGlobalOpenClawToken();

        // Build HTTP dashboard URL without credentials in authority
        var builder = new UriBuilder(rawUri)
        {
            Scheme = rawUri.StartsWith("wss://", StringComparison.OrdinalIgnoreCase) ? "https" : "http",
            UserName = string.Empty,
            Password = string.Empty,
        };

        // Inject token as fragment
        if (!string.IsNullOrEmpty(token))
            builder.Fragment = $"token={Uri.EscapeDataString(token)}";

        return builder.Uri;
    }

    // Builds the A2UI URL from canvasHostUrl (hello-ok) + token from openclaw.json.
    private Uri BuildCanvasA2UIUrl()
    {
        var connection = _sp.GetService<GatewayConnection>();
        var canvasHostUrl = connection?.CanvasHostUrl?.TrimEnd('/');
        if (string.IsNullOrEmpty(canvasHostUrl))
            canvasHostUrl = $"http://127.0.0.1:{GatewayDashboardPort}";

        var a2uiPath = $"{canvasHostUrl}/__openclaw__/a2ui/?platform=windows";

        // Inject token as fragment for auto-auth
        var token = TryReadGlobalOpenClawToken();
        if (!string.IsNullOrEmpty(token))
            a2uiPath += $"#token={Uri.EscapeDataString(token)}";

        return new Uri(a2uiPath);
    }

    private static string? TryReadGlobalOpenClawToken()
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".openclaw", "openclaw.json");
            if (!File.Exists(path)) return null;

            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.TryGetProperty("gateway", out var gw) &&
                gw.TryGetProperty("auth", out var auth) &&
                auth.TryGetProperty("token", out var tok))
                return tok.GetString();
        }
        catch { /* non-fatal */ }
        return null;
    }

    private static Domain.Health.HealthSnapshot? TryDecodeHealthSnapshot(byte[] data)
    {
        try
        {
            return JsonSerializer.Deserialize<Domain.Health.HealthSnapshot>(
                data,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch { return null; }
    }

    private static string ToStateLabel(GatewayState state) => state switch
    {
        GatewayState.Connected       => "Connected",
        GatewayState.Paused          => "Paused",
        GatewayState.Reconnecting    => "Reconnecting…",
        GatewayState.VoiceWakeActive => "Voice Wake",
        _                            => "Disconnected",
    };

    private static string ToIconPath(GatewayState state) => state switch
    {
        GatewayState.Connected       => "ms-appx:///Assets/Icons/tray_connected.ico",
        GatewayState.Paused          => "ms-appx:///Assets/Icons/tray_paused.ico",
        GatewayState.Reconnecting    => "ms-appx:///Assets/Icons/tray_reconnecting.ico",
        GatewayState.VoiceWakeActive => "ms-appx:///Assets/Icons/tray_voice.ico",
        _                            => "ms-appx:///Assets/Icons/tray_disconnected.ico",
    };
}

internal sealed record AudioInputDeviceEntry(string Uid, string Name);
