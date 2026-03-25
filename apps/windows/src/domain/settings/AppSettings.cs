using System.Globalization;
using OpenClawWindows.Domain.Errors;
using OpenClawWindows.Domain.ExecApprovals;
using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Settings;

/// <summary>
/// App-wide settings — persisted as JSON in %APPDATA%\OpenClaw\settings.json.
/// Write-then-rename enforces atomicity.
/// </summary>
public sealed class AppSettings : Entity<Guid>
{
    // ── Core / infra ──────────────────────────────────────────────
    public string AppDataPath { get; private set; }
    public bool AutoStart { get; private set; }          // launchAtLogin equivalent
    public bool IsPaused { get; private set; }
    public bool OnboardingSeen { get; private set; }
    public bool DebugPaneEnabled { get; private set; }
    public string? GatewayEndpointUri { get; private set; }
    public string? WorkspacePath { get; private set; }
    public bool HeartbeatsEnabled { get; private set; }

    // ── Connection mode ───────────────────────────────────────────
    public ConnectionMode ConnectionMode { get; private set; }
    public RemoteTransport RemoteTransport { get; private set; }
    public string RemoteTarget { get; private set; }
    public string RemoteUrl { get; private set; }
    public string RemoteIdentity { get; private set; }
    public string RemoteProjectRoot { get; private set; }
    public string RemoteCliPath { get; private set; }

    // ── Voice wake (swabble) ──────────────────────────────────────
    public float VoiceWakeSensitivity { get; private set; }
    public bool VoiceWakeEnabled { get; private set; }   // swabbleEnabled
    public string[] VoiceWakeTriggerWords { get; private set; }
    public string VoiceWakeMicId { get; private set; }
    // Display name for the selected mic
    public string VoiceWakeMicName { get; private set; }
    public string VoiceWakeLocaleId { get; private set; }
    // Chime stored as display name
    public string VoiceWakeTriggerChime { get; private set; }
    public string VoiceWakeSendChime { get; private set; }
    public bool VoicePushToTalkEnabled { get; private set; }

    // ── Talk mode ─────────────────────────────────────────────────
    public bool TalkEnabled { get; private set; }

    // ── Camera ────────────────────────────────────────────────────
    // User-level flag
    // Controls whether the node declares the "camera" capability to the gateway.
    // Distinct from the OS camera permission (IPermissionManager checks both).
    public bool CameraEnabled { get; private set; }

    // ── Canvas ────────────────────────────────────────────────────
    public bool CanvasEnabled { get; private set; }
    public bool PeekabooBridgeEnabled { get; private set; }

    // ── Exec approvals ────────────────────────────────────────────
    public ExecApprovalMode ExecApprovalMode { get; private set; }

    // ── UI appearance ─────────────────────────────────────────────
    public bool ShowDockIcon { get; private set; }
    public bool IconAnimationsEnabled { get; private set; }
    public string IconOverride { get; private set; }      // "system" or custom identifier
    public string? SeamColorHex { get; private set; }     // gateway-provided accent; null = use default

    // ── Location ──────────────────────────────────────────────────
    public LocationMode LocationMode { get; private set; }

    // ── Tailscale ─────────────────────────────────────────────────
    public TailscaleMode TailscaleMode { get; private set; }
    public bool TailscaleRequireCredentials { get; private set; }
    public string? TailscalePassword { get; private set; }

    // Alias for onboarding checks
    public string? GatewayEndpoint => GatewayEndpointUri;

    private AppSettings(string appDataPath)
    {
        Guard.Against.NullOrWhiteSpace(appDataPath, nameof(appDataPath));
        Id = Guid.NewGuid();
        AppDataPath = appDataPath;

        // ── Defaults mirror macOS AppState init ───────────────────
        AutoStart = true;
        IsPaused = false;
        OnboardingSeen = false;
        DebugPaneEnabled = false;
        HeartbeatsEnabled = true;

        ConnectionMode = ConnectionMode.Unconfigured;
        RemoteTransport = RemoteTransport.Ssh;
        RemoteTarget = string.Empty;
        RemoteUrl = string.Empty;
        RemoteIdentity = string.Empty;
        RemoteProjectRoot = string.Empty;
        RemoteCliPath = string.Empty;

        VoiceWakeSensitivity = 0.5f;
        VoiceWakeEnabled = false;
        VoiceWakeTriggerWords = [];
        VoiceWakeMicId   = string.Empty;
        VoiceWakeMicName = string.Empty;
        VoiceWakeLocaleId = CultureInfo.CurrentCulture.Name;
        VoiceWakeTriggerChime = "Glass";   // macOS default: .system(name: "Glass")
        VoiceWakeSendChime = "Glass";
        VoicePushToTalkEnabled = false;

        TalkEnabled = false;

        CameraEnabled = false;

        CanvasEnabled = true;
        PeekabooBridgeEnabled = true;

        ExecApprovalMode = ExecApprovalMode.Ask;

        ShowDockIcon = false;
        IconAnimationsEnabled = true;
        IconOverride = "system";
        SeamColorHex = null;

        LocationMode = LocationMode.Off;
    }

    public static ErrorOr<AppSettings> Create(string appDataPath)
    {
        if (string.IsNullOrWhiteSpace(appDataPath) || !Path.IsPathRooted(appDataPath))
            return DomainErrors.Settings.AppDataPathInvalid(appDataPath ?? "");

        return new AppSettings(appDataPath);
    }

    // Convenience factory that never fails — used for first-run default initialization.
    public static AppSettings WithDefaults(string appDataPath)
    {
        Guard.Against.NullOrWhiteSpace(appDataPath, nameof(appDataPath));
        return new AppSettings(appDataPath);
    }

    // ── Setters ───────────────────────────────────────────────────

    public ErrorOr<Success> SetVoiceWakeSensitivity(float value)
    {
        if (value is < 0.0f or > 1.0f)
            return DomainErrors.Settings.SensitivityOutOfRange(value);

        VoiceWakeSensitivity = value;
        return Result.Success;
    }

    public void SetAutoStart(bool enabled) => AutoStart = enabled;
    public void SetIsPaused(bool paused) => IsPaused = paused;
    public void SetOnboardingSeen(bool seen) => OnboardingSeen = seen;
    public void SetDebugPaneEnabled(bool enabled) => DebugPaneEnabled = enabled;
    public void SetGatewayEndpointUri(string? uri) => GatewayEndpointUri = uri;
    public void SetWorkspacePath(string? path) => WorkspacePath = path;
    public void SetHeartbeatsEnabled(bool enabled) => HeartbeatsEnabled = enabled;

    public void SetConnectionMode(ConnectionMode mode) => ConnectionMode = mode;
    public void SetRemoteTransport(RemoteTransport transport) => RemoteTransport = transport;
    public void SetRemoteTarget(string target) => RemoteTarget = target ?? string.Empty;
    public void SetRemoteUrl(string url) => RemoteUrl = url ?? string.Empty;
    public void SetRemoteIdentity(string identity) => RemoteIdentity = identity ?? string.Empty;
    public void SetRemoteProjectRoot(string root) => RemoteProjectRoot = root ?? string.Empty;
    public void SetRemoteCliPath(string path) => RemoteCliPath = path ?? string.Empty;

    public void SetVoiceWakeEnabled(bool enabled) => VoiceWakeEnabled = enabled;
    public void SetVoiceWakeTriggerWords(string[] words) => VoiceWakeTriggerWords = words ?? [];
    public void SetVoiceWakeMicId(string micId) => VoiceWakeMicId = micId ?? string.Empty;
    public void SetVoiceWakeMicName(string name) => VoiceWakeMicName = name ?? string.Empty;
    public void SetVoiceWakeLocaleId(string localeId) => VoiceWakeLocaleId = localeId ?? string.Empty;
    public void SetVoiceWakeTriggerChime(string chime) => VoiceWakeTriggerChime = chime ?? "Glass";
    public void SetVoiceWakeSendChime(string chime) => VoiceWakeSendChime = chime ?? "Glass";
    public void SetVoicePushToTalkEnabled(bool enabled) => VoicePushToTalkEnabled = enabled;

    public void SetTalkEnabled(bool enabled) => TalkEnabled = enabled;

    public void SetCameraEnabled(bool enabled) => CameraEnabled = enabled;

    public void SetCanvasEnabled(bool enabled) => CanvasEnabled = enabled;
    public void SetPeekabooBridgeEnabled(bool enabled) => PeekabooBridgeEnabled = enabled;

    public void SetExecApprovalMode(ExecApprovalMode mode) => ExecApprovalMode = mode;

    public void SetShowDockIcon(bool show) => ShowDockIcon = show;
    public void SetIconAnimationsEnabled(bool enabled) => IconAnimationsEnabled = enabled;
    public void SetIconOverride(string iconOverride) => IconOverride = iconOverride ?? "system";
    public void SetSeamColorHex(string? hex) => SeamColorHex = hex;

    public void SetLocationMode(LocationMode mode) => LocationMode = mode;

    public void SetTailscaleMode(TailscaleMode mode) => TailscaleMode = mode;
    public void SetTailscaleRequireCredentials(bool require) => TailscaleRequireCredentials = require;
    public void SetTailscalePassword(string? password) => TailscalePassword = password;
}
