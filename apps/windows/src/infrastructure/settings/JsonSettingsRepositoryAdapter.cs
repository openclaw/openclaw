using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.ExecApprovals;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Settings;

// JSON persistence for AppSettings to %APPDATA%\OpenClaw\settings.json.
// Write-then-rename ensures atomicity
//
// Gateway sync (NE-013):
//   Load: tries config.get (8 s) if connected, caches hash, falls back to local JSON.
//   Save: sends { raw, baseHash } via config.set, then reloads hash.
//         Non-remote mode falls back to local JSON on gateway error.
//         Remote mode propagates the error (no local fallback)
internal sealed class JsonSettingsRepositoryAdapter : ISettingsRepository
{
    private readonly string _settingsPath;
    private readonly ILogger<JsonSettingsRepositoryAdapter> _logger;
    private readonly IGatewayRpcChannel _gateway;
    private readonly GatewayConnection _connection;
    private readonly SemaphoreSlim _lock = new(1, 1);

    // Tunables
    private const int ConfigGetTimeoutMs = 8000;
    private const int ConfigSetTimeoutMs = 10000;

    // DPAPI entropy for remote gateway credentials — isolates these blobs from other DPAPI uses
    private static readonly byte[] CredentialEntropy = "openclaw-remote-creds-v1"u8.ToArray();

    // Cached from last config.get — enables hash-based conflict detection on config.set
    private string? _lastHash;
    // Reflects ConnectionMode of the last loaded/saved settings — determines fallback strategy
    private ConnectionMode _cachedConnectionMode = ConnectionMode.Unconfigured;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        // Serialize enums as camelCase strings for human-readable JSON
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public JsonSettingsRepositoryAdapter(
        IGatewayRpcChannel gateway,
        GatewayConnection connection,
        ILogger<JsonSettingsRepositoryAdapter> logger)
    {
        _gateway = gateway;
        _connection = connection;
        _logger = logger;
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var dir = Path.Combine(appData, "OpenClaw");
        Directory.CreateDirectory(dir);
        _settingsPath = Path.Combine(dir, "settings.json");
    }

    public async Task<AppSettings> LoadAsync(CancellationToken ct)
    {
        // Remote mode: gateway mandatory
        if (_cachedConnectionMode == ConnectionMode.Remote)
        {
            if (_connection.State == GatewayConnectionState.Connected)
            {
                // Refresh hash for config.set conflict detection. The config payload uses
                // the OpenClaw gateway schema (agents/auth/commands/gateway), not the
                // AppSettings schema — deserializing it produces all-defaults and would
                // overwrite the user's remote configuration on the next SaveAsync.
                // Settings are always loaded from the local file.
                await TryLoadFromGatewayAsync(ct);
                var connected = await LoadLocalAsync(ct);
                _cachedConnectionMode = connected.ConnectionMode;
                return connected;
            }
            _logger.LogWarning("Remote mode: gateway unavailable on load, falling back to local file");
            return await LoadLocalAsync(ct);
        }

        // Non-remote: always read from local file.
        // The gateway config (openclaw.json) has a completely different schema from AppSettings
        // (it has agents/auth/commands/gateway, not autoStart/connectionMode/voiceWake*...).
        // Deserializing it into AppSettingsDto produces all-defaults, overwriting real local
        // settings — and saving back causes INVALID_REQUEST from the gateway (BUG-B).
        return await LoadLocalAsync(ct);
    }

    public async Task SaveAsync(AppSettings settings, CancellationToken ct)
    {
        _cachedConnectionMode = settings.ConnectionMode;

        if (_cachedConnectionMode == ConnectionMode.Remote)
        {
            // Save locally first: credentials (RemoteToken/RemotePassword) are never in the gateway
            // schema, and the local file is the only recovery source on restart. Doing this before
            // the gateway write ensures they survive even when the gateway write fails.
            await SaveLocalAsync(settings, ct);
            // Remote mode: gateway mandatory — propagate failure
            await SaveToGatewayAsync(settings, ct);
            return;
        }

        // Non-remote: always save to local file.
        // AppSettings fields (autoStart, connectionMode, voiceWake*, etc.) have no
        // counterpart in the gateway config schema — sending them returns INVALID_REQUEST.
        await SaveLocalAsync(settings, ct);
    }

    private async Task TryLoadFromGatewayAsync(CancellationToken ct)
    {
        try
        {
            var data = await _gateway.ConfigGetAsync(ConfigGetTimeoutMs, ct);
            using var doc = JsonDocument.Parse(data);
            // Cache hash for subsequent config.set — enables conflict detection on save
            if (doc.RootElement.TryGetProperty("hash", out var hashEl))
                _lastHash = hashEl.GetString();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "config.get from gateway failed");
        }
    }

    private async Task SaveToGatewayAsync(AppSettings settings, CancellationToken ct)
    {
        // Windows app settings (connectionMode, remoteUrl, remoteTransport, etc.) have no
        // counterparts in the OpenClaw config schema. Writing AppSettingsDto as config.set.raw
        // would overwrite openclaw.json with mostly-default gateway config, corrupting live
        // settings. Instead, round-trip the current gateway config document unchanged so
        // the baseHash stays fresh. Windows-only fields are already saved locally by SaveLocalAsync.
        var rawBytes = await _gateway.ConfigGetAsync(ConfigGetTimeoutMs, ct);
        using var doc = JsonDocument.Parse(rawBytes);

        if (doc.RootElement.TryGetProperty("hash", out var hashEl))
            _lastHash = hashEl.GetString();

        if (!doc.RootElement.TryGetProperty("config", out var configEl))
            return;

        var rawConfig = configEl.GetRawText();
        var parameters = new Dictionary<string, object?> { ["raw"] = rawConfig };
        if (_lastHash is not null)
            parameters["baseHash"] = _lastHash;

        await _gateway.RequestRawAsync("config.set", parameters, ConfigSetTimeoutMs, ct);

        // Reload to refresh the cached hash — failure here is non-critical
        await TryLoadFromGatewayAsync(ct);
    }

    private async Task<AppSettings> LoadLocalAsync(CancellationToken ct)
    {
        if (!File.Exists(_settingsPath))
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var defaults = AppSettings.WithDefaults(Path.Combine(appData, "OpenClaw"));
            // Bootstrap: use system token so first launch connects without manual setup
            var bootstrapToken = TryReadGlobalOpenClawToken();
            if (bootstrapToken is not null)
                defaults.SetGatewayEndpointUri(InjectTokenIntoUri(null, bootstrapToken));
            return defaults;
        }

        try
        {
            await _lock.WaitAsync(ct);
            try
            {
                await using var stream = File.OpenRead(_settingsPath);
                var dto = await JsonSerializer.DeserializeAsync<AppSettingsDto>(stream, JsonOptions, ct);
                if (dto is null)
                    return DefaultSettings();

                var settings = MapFromDto(dto);
                // Always refresh the gateway token from the system openclaw config so a
                // `openclaw configure` run never leaves the Windows app with a stale token.
                var freshToken = TryReadGlobalOpenClawToken();
                if (freshToken is not null)
                    settings.SetGatewayEndpointUri(InjectTokenIntoUri(settings.GatewayEndpointUri, freshToken));
                return settings;
            }
            finally
            {
                _lock.Release();
            }
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Settings JSON is malformed — returning defaults");
            return DefaultSettings();
        }
    }

    public async Task SaveLocalAsync(AppSettings settings, CancellationToken ct)
    {
        var tmpPath = _settingsPath + ".tmp";

        await _lock.WaitAsync(ct);
        try
        {
            // Write to .tmp first, then atomic rename — prevents corruption on crash
            await using (var stream = File.Create(tmpPath))
            {
                var dto = MapToDto(settings);
                // Encrypt credentials so they are not persisted as plaintext JSON.
                dto.RemoteToken    = EncryptCredential(dto.RemoteToken);
                dto.RemotePassword = EncryptCredential(dto.RemotePassword);
                await JsonSerializer.SerializeAsync(stream, dto, JsonOptions, ct);
            }

            File.Move(tmpPath, _settingsPath, overwrite: true);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save settings to {Path}", _settingsPath);
            if (File.Exists(tmpPath))
                File.Delete(tmpPath);
            throw;
        }
        finally
        {
            _lock.Release();
        }
    }

    private AppSettings DefaultSettings()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return AppSettings.WithDefaults(Path.Combine(appData, "OpenClaw"));
    }

    // Reads the gateway auth token from ~/.openclaw/openclaw.json.
    // Returns null if the file is missing or the token field is absent.
    private static string? TryReadGlobalOpenClawToken()
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".openclaw", "openclaw.json");
            if (!File.Exists(path)) return null;

            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.TryGetProperty("gateway", out var gw) &&
                gw.TryGetProperty("auth", out var auth) &&
                auth.TryGetProperty("token", out var tok))
                return tok.GetString();
        }
        catch { /* non-fatal */ }
        return null;
    }

    // Injects the system gateway token into the URI so the app always uses the current token
    // even after `openclaw configure` changes it.
    private static string InjectTokenIntoUri(string? existingUri, string token)
    {
        // Default to loopback if no URI is configured yet
        var scheme = "ws";
        var host   = "127.0.0.1:18789";
        if (!string.IsNullOrWhiteSpace(existingUri) &&
            Uri.TryCreate(existingUri.Trim(), UriKind.Absolute, out var parsed))
        {
            // Preserve original scheme (ws/wss) — dropping it silently downgrades TLS.
            scheme = parsed.Scheme;
            var port = parsed.Port > 0 ? parsed.Port : 18789;
            host = $"{parsed.Host}:{port}";
        }
        return $"{scheme}://{token}@{host}";
    }

    private static AppSettings MapFromDto(AppSettingsDto dto)
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var settings = AppSettings.WithDefaults(Path.Combine(appData, "OpenClaw"));

        // Core
        settings.SetAutoStart(dto.AutoStart);
        settings.SetIsPaused(dto.IsPaused);
        settings.SetOnboardingSeen(dto.OnboardingSeen);
        settings.SetDebugPaneEnabled(dto.DebugPaneEnabled);
        settings.SetGatewayEndpointUri(dto.GatewayEndpointUri);
        settings.SetWorkspacePath(dto.WorkspacePath);
        settings.SetHeartbeatsEnabled(dto.HeartbeatsEnabled);

        // Connection mode
        settings.SetConnectionMode(dto.ConnectionMode);
        settings.SetRemoteTransport(dto.RemoteTransport);
        settings.SetRemoteTarget(dto.RemoteTarget);
        settings.SetRemoteUrl(dto.RemoteUrl);
        settings.SetRemoteToken(DecryptCredential(dto.RemoteToken));
        settings.SetRemotePassword(DecryptCredential(dto.RemotePassword));
        settings.SetRemoteIdentity(dto.RemoteIdentity);
        settings.SetRemoteProjectRoot(dto.RemoteProjectRoot);
        settings.SetRemoteCliPath(dto.RemoteCliPath);

        // Voice wake
        settings.SetVoiceWakeSensitivity(dto.VoiceWakeSensitivity);
        settings.SetVoiceWakeEnabled(dto.VoiceWakeEnabled);
        settings.SetVoiceWakeTriggerWords(dto.VoiceWakeTriggerWords);
        settings.SetVoiceWakeMicId(dto.VoiceWakeMicId);
        settings.SetVoiceWakeMicName(dto.VoiceWakeMicName);
        settings.SetVoiceWakeLocaleId(dto.VoiceWakeLocaleId);
        settings.SetVoiceWakeTriggerChime(dto.VoiceWakeTriggerChime);
        settings.SetVoiceWakeSendChime(dto.VoiceWakeSendChime);
        settings.SetVoicePushToTalkEnabled(dto.VoicePushToTalkEnabled);

        // Talk
        settings.SetTalkEnabled(dto.TalkEnabled);

        // Camera
        settings.SetCameraEnabled(dto.CameraEnabled);

        // Canvas
        settings.SetCanvasEnabled(dto.CanvasEnabled);
        settings.SetPeekabooBridgeEnabled(dto.PeekabooBridgeEnabled);

        // Exec approvals
        settings.SetExecApprovalMode(dto.ExecApprovalMode);

        // UI appearance
        settings.SetShowDockIcon(dto.ShowDockIcon);
        settings.SetIconAnimationsEnabled(dto.IconAnimationsEnabled);
        settings.SetIconOverride(dto.IconOverride);
        settings.SetSeamColorHex(dto.SeamColorHex);

        // Location
        settings.SetLocationMode(dto.LocationMode);

        // Tailscale
        settings.SetTailscaleMode(dto.TailscaleMode);
        settings.SetTailscaleRequireCredentials(dto.TailscaleRequireCredentials);
        settings.SetTailscalePassword(DecryptCredential(dto.TailscalePassword ?? string.Empty));

        return settings;
    }

    private static AppSettingsDto MapToDto(AppSettings s) => new()
    {
        // Core
        AutoStart = s.AutoStart,
        IsPaused = s.IsPaused,
        OnboardingSeen = s.OnboardingSeen,
        DebugPaneEnabled = s.DebugPaneEnabled,
        GatewayEndpointUri = s.GatewayEndpointUri,
        WorkspacePath = s.WorkspacePath,
        HeartbeatsEnabled = s.HeartbeatsEnabled,

        // Connection mode
        ConnectionMode = s.ConnectionMode,
        RemoteTransport = s.RemoteTransport,
        RemoteTarget = s.RemoteTarget,
        RemoteUrl = s.RemoteUrl,
        RemoteToken = s.RemoteToken,
        RemotePassword = s.RemotePassword,
        RemoteIdentity = s.RemoteIdentity,
        RemoteProjectRoot = s.RemoteProjectRoot,
        RemoteCliPath = s.RemoteCliPath,

        // Voice wake
        VoiceWakeSensitivity = s.VoiceWakeSensitivity,
        VoiceWakeEnabled = s.VoiceWakeEnabled,
        VoiceWakeTriggerWords = s.VoiceWakeTriggerWords,
        VoiceWakeMicId   = s.VoiceWakeMicId,
        VoiceWakeMicName = s.VoiceWakeMicName,
        VoiceWakeLocaleId = s.VoiceWakeLocaleId,
        VoiceWakeTriggerChime = s.VoiceWakeTriggerChime,
        VoiceWakeSendChime = s.VoiceWakeSendChime,
        VoicePushToTalkEnabled = s.VoicePushToTalkEnabled,

        // Talk
        TalkEnabled = s.TalkEnabled,

        // Camera
        CameraEnabled = s.CameraEnabled,

        // Canvas
        CanvasEnabled = s.CanvasEnabled,
        PeekabooBridgeEnabled = s.PeekabooBridgeEnabled,

        // Exec approvals
        ExecApprovalMode = s.ExecApprovalMode,

        // UI appearance
        ShowDockIcon = s.ShowDockIcon,
        IconAnimationsEnabled = s.IconAnimationsEnabled,
        IconOverride = s.IconOverride,
        SeamColorHex = s.SeamColorHex,

        // Location
        LocationMode = s.LocationMode,

        // Tailscale
        TailscaleMode = s.TailscaleMode,
        TailscaleRequireCredentials = s.TailscaleRequireCredentials,
        TailscalePassword = EncryptCredential(s.TailscalePassword ?? string.Empty),
    };

    private static string EncryptCredential(string value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        try
        {
            var encrypted = ProtectedData.Protect(
                Encoding.UTF8.GetBytes(value), CredentialEntropy, DataProtectionScope.CurrentUser);
            return "dpapi:" + Convert.ToBase64String(encrypted);
        }
        catch
        {
            // DPAPI unavailable (headless CI, LocalSystem account) — fall back to plaintext
            Console.Error.WriteLine(
                "[JsonSettingsRepositoryAdapter] DPAPI unavailable — credential stored as plaintext. " +
                "This is expected in CI/headless environments but should not occur in normal desktop use.");
            return value;
        }
    }

    private static string DecryptCredential(string value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        if (!value.StartsWith("dpapi:", StringComparison.Ordinal))
            return value; // plaintext — pre-DPAPI file or migration path
        try
        {
            var decrypted = ProtectedData.Unprotect(
                Convert.FromBase64String(value["dpapi:".Length..]), CredentialEntropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(decrypted);
        }
        catch
        {
            return string.Empty; // credentials lost on profile change — cleaner than corrupted data
        }
    }

    // Private DTO — keeps AppSettings domain-pure (no JSON annotations in domain)
    private sealed class AppSettingsDto
    {
        // Core
        public bool AutoStart { get; set; } = true;
        public bool IsPaused { get; set; }
        public bool OnboardingSeen { get; set; }
        public bool DebugPaneEnabled { get; set; }
        public string? GatewayEndpointUri { get; set; }
        public string? WorkspacePath { get; set; }
        public bool HeartbeatsEnabled { get; set; } = true;

        // Connection mode
        public ConnectionMode ConnectionMode { get; set; } = ConnectionMode.Unconfigured;
        public RemoteTransport RemoteTransport { get; set; } = RemoteTransport.Ssh;
        public string RemoteTarget { get; set; } = string.Empty;
        public string RemoteUrl { get; set; } = string.Empty;
        public string RemoteToken { get; set; } = string.Empty;
        public string RemotePassword { get; set; } = string.Empty;
        public string RemoteIdentity { get; set; } = string.Empty;
        public string RemoteProjectRoot { get; set; } = string.Empty;
        public string RemoteCliPath { get; set; } = string.Empty;

        // Voice wake
        public float VoiceWakeSensitivity { get; set; } = 0.5f;
        public bool VoiceWakeEnabled { get; set; }
        public string[] VoiceWakeTriggerWords { get; set; } = [];
        public string VoiceWakeMicId   { get; set; } = string.Empty;
        public string VoiceWakeMicName { get; set; } = string.Empty;
        public string VoiceWakeLocaleId { get; set; } = string.Empty;
        public string VoiceWakeTriggerChime { get; set; } = "Glass";
        public string VoiceWakeSendChime { get; set; } = "Glass";
        public bool VoicePushToTalkEnabled { get; set; }

        // Talk
        public bool TalkEnabled { get; set; }

        // Camera
        public bool CameraEnabled { get; set; }

        // Canvas
        public bool CanvasEnabled { get; set; } = true;
        public bool PeekabooBridgeEnabled { get; set; } = true;

        // Exec approvals
        public ExecApprovalMode ExecApprovalMode { get; set; } = ExecApprovalMode.Ask;

        // UI appearance
        public bool ShowDockIcon { get; set; }
        public bool IconAnimationsEnabled { get; set; } = true;
        public string IconOverride { get; set; } = "system";
        public string? SeamColorHex { get; set; }

        // Location
        public LocationMode LocationMode { get; set; } = LocationMode.Off;

        // Tailscale
        public TailscaleMode TailscaleMode { get; set; }
        public bool TailscaleRequireCredentials { get; set; }
        public string? TailscalePassword { get; set; }
    }
}
