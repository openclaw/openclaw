using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Config;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Resolves and publishes the effective gateway control endpoint.
/// for testability. The launchd plist token/password path is omitted — on Windows only
/// env vars and openclaw.json are used.
/// </summary>
internal sealed class GatewayEndpointStore : IGatewayEndpointStore, IDisposable
{
    // Tunables
    private static readonly HashSet<string> SupportedBindModes =
        ["loopback", "tailnet", "lan", "auto", "custom"];
    private const string RemoteConnectingDetail = "Connecting to remote gateway\u2026";

    // One-per-process env-override warnings)
    private static int _tokenWarned;
    private static int _passwordWarned;

    private readonly ISettingsRepository _settings;
    private readonly ITailscaleService   _tailscale;
    private readonly RemoteTunnelManager _tunnel;
    private readonly ILogger<GatewayEndpointStore> _logger;

    // Fast lock for _state — safe to hold in synchronous paths
    private readonly Lock _stateLock = new();
    // Async lock for _remoteEnsure — held only while mutating the ensure reference
    private readonly SemaphoreSlim _ensureLock = new(1, 1);

    private GatewayEndpointState _state;
    private (Guid Token, Task<ErrorOr<int>> Task)? _remoteEnsure;

    public GatewayEndpointState CurrentState
    {
        get { lock (_stateLock) { return _state; } }
    }

    public event EventHandler<GatewayEndpointState>? StateChanged;

    public GatewayEndpointStore(
        ISettingsRepository settings,
        ITailscaleService tailscale,
        RemoteTunnelManager tunnel,
        ILogger<GatewayEndpointStore> logger)
    {
        _settings  = settings;
        _tailscale = tailscale;
        _tunnel    = tunnel;
        _logger    = logger;

        // Compute initial state synchronously from config file + env vars.
        // UserDefaults read is synchronous; here we use openclaw.json.
        var root     = OpenClawConfigFile.LoadDict();
        var env      = GetEnv();
        var port     = GatewayEnvironment.GatewayPort();
        var bind     = ResolveGatewayBindMode(root, env);
        var custom   = ResolveGatewayCustomBindHost(root);
        var scheme   = ResolveGatewayScheme(root, env);
        var host     = ResolveLocalGatewayHost(bind, custom, null);
        var token    = ResolveGatewayToken(isRemote: false, root: root, env: env);
        var password = ResolveGatewayPassword(isRemote: false, root: root, env: env);
        var mode     = ResolveInitialMode(root);

        _state = mode switch
        {
            ConnectionMode.Remote =>
                new GatewayEndpointState.Connecting(ConnectionMode.Remote, RemoteConnectingDetail),
            ConnectionMode.Unconfigured =>
                new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "Gateway not configured"),
            _ =>
                new GatewayEndpointState.Ready(
                    ConnectionMode.Local,
                    new Uri($"{scheme}://{host}:{port}"),
                    token,
                    password),
        };
    }

    // ── IGatewayEndpointStore ────────────────────────────────────────────────

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        var settings = await _settings.LoadAsync(ct).ConfigureAwait(false);
        var root     = OpenClawConfigFile.LoadDict();
        var mode     = ResolveEffectiveMode(settings, root);
        await SetModeAsync(mode, ct).ConfigureAwait(false);
    }

    public async Task SetModeAsync(ConnectionMode mode, CancellationToken ct = default)
    {
        var root     = OpenClawConfigFile.LoadDict();
        var env      = GetEnv();
        var isRemote = mode == ConnectionMode.Remote;
        var token    = ResolveGatewayToken(isRemote: isRemote, root: root, env: env);
        var password = ResolveGatewayPassword(isRemote: isRemote, root: root, env: env);

        switch (mode)
        {
            case ConnectionMode.Local:
            {
                await CancelRemoteEnsureAsync(ct).ConfigureAwait(false);
                var port   = GatewayEnvironment.GatewayPort();
                var bind   = ResolveGatewayBindMode(root, env);
                var custom = ResolveGatewayCustomBindHost(root);
                var scheme = ResolveGatewayScheme(root, env);
                var tsIp   = _tailscale.TailscaleIP;
                var host   = ResolveLocalGatewayHost(bind, custom, tsIp);
                SetState(new GatewayEndpointState.Ready(
                    ConnectionMode.Local,
                    new Uri($"{scheme}://{host}:{port}"),
                    token,
                    password));
                break;
            }

            case ConnectionMode.Remote:
            {
                // Load settings for transport resolution and SSH tunnel config.
                var settings = await _settings.LoadAsync(ct).ConfigureAwait(false);
                // When openclaw.json has an explicit transport, use it.
                // When openclaw.json has a remote section but no transport, default to SSH
                //   (missing transport = SSH, not a signal to reuse the persisted value).
                // When openclaw.json has no remote section at all (UI-only install), fall back
                //   to settings.RemoteTransport so deep-link / onboarding setups work.
                var transport = GatewayRemoteConfig.HasTransportEntry(root)
                    ? GatewayRemoteConfig.ResolveTransport(root)
                    : GatewayRemoteConfig.HasRemoteSection(root)
                        ? RemoteTransport.Ssh
                        : settings.RemoteTransport;

                if (transport == RemoteTransport.Direct)
                {
                    // URL: config file is authoritative; settings.RemoteUrl is the fallback for UI-only setups.
                    var url = GatewayRemoteConfig.ResolveGatewayUrl(root)
                           ?? GatewayRemoteConfig.NormalizeGatewayUrl(settings.RemoteUrl);
                    if (url is null)
                    {
                        await CancelRemoteEnsureAsync(ct).ConfigureAwait(false);
                        SetState(new GatewayEndpointState.Unavailable(
                            ConnectionMode.Remote,
                            "gateway.remote.url missing or invalid for direct transport"));
                        return;
                    }
                    // Credentials: config/env are authoritative when present — never mix with settings
                    // to avoid a stale persisted token overriding a config-file password.
                    // Fall back to settings only when config has no gateway.remote section at all
                    // (UI-only installs). When the section exists but auth fields are absent the
                    // user explicitly removed auth — use null rather than re-injecting stale settings.
                    string? directToken;
                    string? directPassword;
                    if (!string.IsNullOrEmpty(token) || !string.IsNullOrEmpty(password)
                        || GatewayRemoteConfig.HasRemoteSection(root))
                    {
                        directToken    = token;
                        directPassword = password;
                    }
                    else
                    {
                        directToken    = settings.RemoteToken.Length    > 0 ? settings.RemoteToken    : null;
                        directPassword = settings.RemotePassword.Length > 0 ? settings.RemotePassword : null;
                    }
                    await CancelRemoteEnsureAsync(ct).ConfigureAwait(false);
                    SetState(new GatewayEndpointState.Ready(ConnectionMode.Remote, url, directToken, directPassword));
                    return;
                }

                // SSH transport — set connecting and kick ensure task
                SetState(new GatewayEndpointState.Connecting(ConnectionMode.Remote, RemoteConnectingDetail));
                await _ensureLock.WaitAsync(ct).ConfigureAwait(false);
                try { KickRemoteEnsureIfNeeded(settings, root); }
                finally { _ensureLock.Release(); }
                break;
            }

            default:
            {
                await CancelRemoteEnsureAsync(ct).ConfigureAwait(false);
                SetState(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "Gateway not configured"));
                break;
            }
        }
    }

    public async Task<GatewayEndpointConfig> RequireConfigAsync(CancellationToken ct = default)
    {
        await RefreshAsync(ct).ConfigureAwait(false);
        var snap = CurrentState;

        if (snap is GatewayEndpointState.Ready r)
            return new GatewayEndpointConfig(r.Url, r.Token, r.Password);

        if (snap is GatewayEndpointState.Connecting c && c.Mode == ConnectionMode.Remote)
            return await EnsureRemoteConfigAsync(RemoteConnectingDetail, ct).ConfigureAwait(false);

        if (snap is GatewayEndpointState.Unavailable u && u.Mode == ConnectionMode.Remote)
        {
            // Auto-recover for remote mode: recreate tunnel on demand
            _logger.LogInformation(
                "endpoint unavailable; ensuring remote control tunnel reason={Reason}", u.Reason);
            return await EnsureRemoteConfigAsync(RemoteConnectingDetail, ct).ConfigureAwait(false);
        }

        var reason = snap is GatewayEndpointState.Unavailable ux ? ux.Reason : "Connecting\u2026";
        throw new InvalidOperationException(reason);
    }

    public async Task<ushort> EnsureRemoteControlTunnelAsync(CancellationToken ct = default)
    {
        await RequireRemoteModeAsync(ct).ConfigureAwait(false);

        var root     = OpenClawConfigFile.LoadDict();
        var settings = await _settings.LoadAsync(ct).ConfigureAwait(false);
        // Mirror SetModeAsync transport resolution: config explicit → SSH default when section present → settings fallback.
        var transport = GatewayRemoteConfig.HasTransportEntry(root)
            ? GatewayRemoteConfig.ResolveTransport(root)
            : GatewayRemoteConfig.HasRemoteSection(root)
                ? RemoteTransport.Ssh
                : settings.RemoteTransport;

        if (transport == RemoteTransport.Direct)
        {
            var url = GatewayRemoteConfig.ResolveGatewayUrl(root)
                   ?? GatewayRemoteConfig.NormalizeGatewayUrl(settings.RemoteUrl);
            if (url is null)
                throw new InvalidOperationException("gateway.remote.url missing or invalid");
            var directPort = GatewayRemoteConfig.DefaultPort(url);
            if (directPort is null)
                throw new InvalidOperationException("Invalid gateway.remote.url port");
            _logger.LogInformation("remote transport direct; skipping SSH tunnel");
            return checked((ushort)directPort.Value);
        }

        var config = await EnsureRemoteConfigAsync(RemoteConnectingDetail, ct).ConfigureAwait(false);
        return checked((ushort)config.Url.Port);
    }

    public async Task<GatewayEndpointConfig?> MaybeFallbackToTailnetAsync(Uri currentUrl, CancellationToken ct = default)
    {
        var settings = await _settings.LoadAsync(ct).ConfigureAwait(false);
        var root = OpenClawConfigFile.LoadDict();
        if (ResolveEffectiveMode(settings, root) != ConnectionMode.Local) return null;
        var env  = GetEnv();
        if (ResolveGatewayBindMode(root, env) != "tailnet") return null;

        var currentHost = currentUrl.Host.ToLowerInvariant();
        if (currentHost != "127.0.0.1" && currentHost != "localhost") return null;

        var tsIp = _tailscale.TailscaleIP;
        if (string.IsNullOrEmpty(tsIp)) return null;

        var scheme   = ResolveGatewayScheme(root, env);
        var port     = GatewayEnvironment.GatewayPort();
        var token    = ResolveGatewayToken(isRemote: false, root: root, env: env);
        var password = ResolveGatewayPassword(isRemote: false, root: root, env: env);
        var url      = new Uri($"{scheme}://{tsIp}:{port}");

        _logger.LogInformation("auto bind fallback to tailnet host={Host}", tsIp);
        SetState(new GatewayEndpointState.Ready(ConnectionMode.Local, url, token, password));
        return new GatewayEndpointConfig(url, token, password);
    }

    public void Dispose() => _ensureLock.Dispose();

    // ── Static resolution helpers (internal for tests) ──

    internal static string? ResolveGatewayToken(
        bool isRemote,
        Dictionary<string, object?> root,
        Dictionary<string, string> env)
    {
        var raw     = env.GetValueOrDefault("OPENCLAW_GATEWAY_TOKEN") ?? "";
        var trimmed = raw.Trim();
        if (!string.IsNullOrEmpty(trimmed))
        {
            var configToken = ResolveConfigToken(isRemote, root);
            if (!string.IsNullOrEmpty(configToken) && configToken != trimmed)
                WarnEnvOverrideOnce(ref _tokenWarned, "OPENCLAW_GATEWAY_TOKEN",
                    isRemote ? "gateway.remote.token" : "gateway.auth.token");
            return trimmed;
        }

        var tok = ResolveConfigToken(isRemote, root);
        if (!string.IsNullOrEmpty(tok))
            return tok;

        // Remote mode has no launchd fallback on Windows
        return null;
    }

    internal static string? ResolveGatewayPassword(
        bool isRemote,
        Dictionary<string, object?> root,
        Dictionary<string, string> env)
    {
        var raw     = env.GetValueOrDefault("OPENCLAW_GATEWAY_PASSWORD") ?? "";
        var trimmed = raw.Trim();
        if (!string.IsNullOrEmpty(trimmed))
        {
            var configPw = ResolveConfigPassword(isRemote, root);
            if (!string.IsNullOrEmpty(configPw))
                WarnEnvOverrideOnce(ref _passwordWarned, "OPENCLAW_GATEWAY_PASSWORD",
                    isRemote ? "gateway.remote.password" : "gateway.auth.password");
            return trimmed;
        }

        return ResolveConfigPassword(isRemote, root);
    }

    internal static string? ResolveGatewayBindMode(
        Dictionary<string, object?> root,
        Dictionary<string, string> env)
    {
        if (env.TryGetValue("OPENCLAW_GATEWAY_BIND", out var envBind))
        {
            var t = envBind.Trim().ToLowerInvariant();
            if (SupportedBindModes.Contains(t)) return t;
        }
        if (root.GetValueOrDefault("gateway") is Dictionary<string, object?> gw &&
            gw.GetValueOrDefault("bind") is string cfgBind)
        {
            var t = cfgBind.Trim().ToLowerInvariant();
            if (SupportedBindModes.Contains(t)) return t;
        }
        return null;
    }

    internal static string? ResolveGatewayCustomBindHost(Dictionary<string, object?> root)
    {
        if (root.GetValueOrDefault("gateway") is not Dictionary<string, object?> gw) return null;
        if (gw.GetValueOrDefault("customBindHost") is not string raw) return null;
        var t = raw.Trim();
        return t.Length > 0 ? t : null;
    }

    internal static string ResolveGatewayScheme(
        Dictionary<string, object?> root,
        Dictionary<string, string> env)
    {
        if (env.TryGetValue("OPENCLAW_GATEWAY_TLS", out var envTls) && !string.IsNullOrWhiteSpace(envTls))
            return (envTls.Trim() == "1" || envTls.Trim().ToLowerInvariant() == "true") ? "wss" : "ws";
        if (root.GetValueOrDefault("gateway") is Dictionary<string, object?> gw &&
            gw.GetValueOrDefault("tls") is Dictionary<string, object?> tls &&
            tls.GetValueOrDefault("enabled") is bool enabled)
            return enabled ? "wss" : "ws";
        return "ws";
    }

    internal static string ResolveLocalGatewayHost(
        string? bindMode,
        string? customBindHost,
        string? tailscaleIP)
        => bindMode switch
        {
            "tailnet" => tailscaleIP ?? "127.0.0.1",
            "auto"    => "127.0.0.1",
            "custom"  => customBindHost ?? "127.0.0.1",
            _         => "127.0.0.1",
        };

    internal static GatewayEndpointConfig LocalConfig(
        Dictionary<string, object?> root,
        Dictionary<string, string> env,
        string? tailscaleIP)
    {
        var port     = GatewayEnvironment.GatewayPort();
        var bind     = ResolveGatewayBindMode(root, env);
        var custom   = ResolveGatewayCustomBindHost(root);
        var scheme   = ResolveGatewayScheme(root, env);
        var host     = ResolveLocalGatewayHost(bind, custom, tailscaleIP);
        var token    = ResolveGatewayToken(isRemote: false, root: root, env: env);
        var password = ResolveGatewayPassword(isRemote: false, root: root, env: env);
        return new GatewayEndpointConfig(new Uri($"{scheme}://{host}:{port}"), token, password);
    }

    internal static string NormalizeDashboardPath(string? rawPath)
    {
        var trimmed = (rawPath ?? "").Trim();
        if (trimmed.Length == 0) return "/";
        var withLeading = trimmed.StartsWith('/') ? trimmed : "/" + trimmed;
        if (withLeading == "/") return "/";
        return withLeading.EndsWith('/') ? withLeading : withLeading + "/";
    }

    internal static Uri DashboardUrl(
        GatewayEndpointConfig config,
        ConnectionMode mode,
        string? localBasePath = null)
    {
        var builder = new UriBuilder(config.Url)
        {
            Scheme = config.Url.Scheme.ToLowerInvariant() switch
            {
                "wss" => "https",
                "ws"  => "http",
                _     => "http",
            },
        };

        var rawPath = config.Url.AbsolutePath;
        var urlPath = NormalizeDashboardPath(rawPath is "/" or "" ? null : rawPath);
        if (urlPath != "/")
        {
            builder.Path = urlPath;
        }
        else if (mode == ConnectionMode.Local)
        {
            builder.Path = NormalizeDashboardPath(localBasePath ?? LocalControlUiBasePath());
        }
        else
        {
            builder.Path = "/";
        }

        builder.Query = string.Empty;

        var token = config.Token?.Trim();
        builder.Fragment = !string.IsNullOrEmpty(token)
            ? $"token={Uri.EscapeDataString(token!)}"
            : string.Empty;

        return builder.Uri;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private static string? ResolveConfigToken(bool isRemote, Dictionary<string, object?> root)
    {
        if (isRemote)
        {
            if (root.GetValueOrDefault("gateway") is Dictionary<string, object?> gw &&
                gw.GetValueOrDefault("remote") is Dictionary<string, object?> rem &&
                rem.GetValueOrDefault("token") is string t)
            {
                var trimmed = t.Trim();
                return trimmed.Length > 0 ? trimmed : null;
            }
            return null;
        }
        // Local: gateway.auth.token — suppressed when auth.mode=password so callers
        // naturally fall through to the password credential.
        if (root.GetValueOrDefault("gateway") is not Dictionary<string, object?> lgw) return null;
        if (lgw.GetValueOrDefault("auth") is not Dictionary<string, object?> auth) return null;
        var mode = (auth.GetValueOrDefault("mode") as string)?.Trim().ToLowerInvariant();
        if (mode == "password") return null;
        var lt = auth.GetValueOrDefault("token") as string;
        var tok = lt?.Trim();
        return string.IsNullOrEmpty(tok) ? null : tok;
    }

    private static string? ResolveConfigPassword(bool isRemote, Dictionary<string, object?> root)
    {
        if (isRemote)
        {
            if (root.GetValueOrDefault("gateway") is Dictionary<string, object?> gw &&
                gw.GetValueOrDefault("remote") is Dictionary<string, object?> rem &&
                rem.GetValueOrDefault("password") is string p)
            {
                var trimmed = p.Trim();
                return trimmed.Length > 0 ? trimmed : null;
            }
            return null;
        }
        // Local: gateway.auth.password
        if (root.GetValueOrDefault("gateway") is Dictionary<string, object?> lgw &&
            lgw.GetValueOrDefault("auth") is Dictionary<string, object?> auth &&
            auth.GetValueOrDefault("password") is string lp)
        {
            var trimmed = lp.Trim();
            return trimmed.Length > 0 ? trimmed : null;
        }
        return null;
    }

    private static void WarnEnvOverrideOnce(ref int warned, string envVar, string configKey)
    {
        if (Interlocked.CompareExchange(ref warned, 1, 0) == 0)
            Console.Error.WriteLine(
                $"[GatewayEndpointStore] {envVar} is set and overrides {configKey}. " +
                "If unintentional, clear the environment variable.");
    }

    private static string LocalControlUiBasePath()
    {
        var root = OpenClawConfigFile.LoadDict();
        if (root.GetValueOrDefault("gateway") is not Dictionary<string, object?> gw) return "/";
        if (gw.GetValueOrDefault("controlUi") is not Dictionary<string, object?> cui) return "/";
        return NormalizeDashboardPath(cui.GetValueOrDefault("basePath") as string);
    }

    private static ConnectionMode ResolveInitialMode(Dictionary<string, object?> root)
    {
        if (root.GetValueOrDefault("gateway") is not Dictionary<string, object?> gw)
            return ConnectionMode.Unconfigured;
        var raw = (gw.GetValueOrDefault("mode") as string)?.Trim().ToLowerInvariant();
        return raw switch
        {
            "local"  => ConnectionMode.Local,
            "remote" => ConnectionMode.Remote,
            _        => ConnectionMode.Unconfigured,
        };
    }

    private static ConnectionMode ResolveEffectiveMode(AppSettings settings, Dictionary<string, object?> root)
    {
        // Explicit Remote or Local in AppSettings are definitive — honour them before any
        // heuristic (including the legacy RemoteUrl signal).
        if (settings.ConnectionMode == ConnectionMode.Remote)
            return ConnectionMode.Remote;
        if (settings.ConnectionMode == ConnectionMode.Local)
            return ConnectionMode.Local;
        // Only apply the legacy RemoteUrl heuristic when mode is Unconfigured — a stale
        // RemoteUrl must not silently override an explicit Local selection.
        if (!string.IsNullOrWhiteSpace(settings.RemoteUrl))
            return ConnectionMode.Remote;
        // Config file is authoritative for local/remote when AppSettings is neutral.
        var configMode = ResolveInitialMode(root);
        if (configMode != ConnectionMode.Unconfigured)
            return configMode;
        return settings.OnboardingSeen ? ConnectionMode.Local : ConnectionMode.Unconfigured;
    }

    private static Dictionary<string, string> GetEnv()
    {
        var vars = Environment.GetEnvironmentVariables();
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry kv in vars)
        {
            if (kv.Key is string k && kv.Value is string v)
                dict[k] = v;
        }
        return dict;
    }

    private void SetState(GatewayEndpointState next)
    {
        bool changed;
        lock (_stateLock)
        {
            changed = !_state.Equals(next);
            if (changed) _state = next;
        }
        if (!changed) return;

        StateChanged?.Invoke(this, next);
        switch (next)
        {
            case GatewayEndpointState.Ready r:
                _logger.LogDebug("resolved endpoint mode={Mode} url={Url}", r.Mode, r.Url);
                break;
            case GatewayEndpointState.Connecting c:
                _logger.LogDebug("endpoint connecting mode={Mode} detail={Detail}", c.Mode, c.Detail);
                break;
            case GatewayEndpointState.Unavailable u:
                _logger.LogDebug("endpoint unavailable mode={Mode} reason={Reason}", u.Mode, u.Reason);
                break;
        }
    }

    private async Task CancelRemoteEnsureAsync(CancellationToken ct)
    {
        await _ensureLock.WaitAsync(ct).ConfigureAwait(false);
        try { _remoteEnsure = null; }
        finally { _ensureLock.Release(); }
    }

    // Must be called while holding _ensureLock
    private void KickRemoteEnsureIfNeeded(AppSettings settings, Dictionary<string, object?> root)
    {
        if (_remoteEnsure is not null) return; // already in flight

        var token       = Guid.NewGuid();
        var target      = settings.RemoteTarget?.Trim() ?? "";
        var identity    = settings.RemoteIdentity?.Trim();
        var sshEndpoint = !string.IsNullOrEmpty(identity) ? $"{identity}@{target}" : target;
        var desiredPort = GatewayEnvironment.GatewayPort();
        var remotePort  = ResolveRemoteGatewayPort(root, settings);
        var task        = _tunnel.EnsureControlTunnelAsync(sshEndpoint, desiredPort, remotePort, CancellationToken.None);
        _remoteEnsure   = (token, task);
    }

    private static int ResolveRemoteGatewayPort(Dictionary<string, object?> root, AppSettings settings)
    {
        // settings.RemoteUrl wins: this is the URL the user just saved in the UI.
        // Config is the fallback for setups where the URL lives only in openclaw.json.
        var settingsUrl = GatewayRemoteConfig.NormalizeGatewayUrl(settings.RemoteUrl);
        if (settingsUrl is not null)
        {
            var p = GatewayRemoteConfig.DefaultPort(settingsUrl);
            if (p is not null) return p.Value;
        }
        var cfgUrl = GatewayRemoteConfig.ResolveGatewayUrl(root);
        if (cfgUrl is not null)
        {
            var p = GatewayRemoteConfig.DefaultPort(cfgUrl);
            if (p is not null) return p.Value;
        }
        return GatewayEnvironment.GatewayPort();
    }

    private async Task RequireRemoteModeAsync(CancellationToken ct)
    {
        var settings = await _settings.LoadAsync(ct).ConfigureAwait(false);
        var root     = OpenClawConfigFile.LoadDict();
        if (ResolveEffectiveMode(settings, root) != ConnectionMode.Remote)
            throw new InvalidOperationException("Remote mode is not enabled");
    }

    private async Task<GatewayEndpointConfig> EnsureRemoteConfigAsync(string detail, CancellationToken ct)
    {
        await RequireRemoteModeAsync(ct).ConfigureAwait(false);

        var root = OpenClawConfigFile.LoadDict();
        if (GatewayRemoteConfig.ResolveTransport(root) == RemoteTransport.Direct)
        {
            var url = GatewayRemoteConfig.ResolveGatewayUrl(root);
            if (url is null) throw new InvalidOperationException("gateway.remote.url missing or invalid");
            var env      = GetEnv();
            var token    = ResolveGatewayToken(isRemote: true, root: root, env: env);
            var password = ResolveGatewayPassword(isRemote: true, root: root, env: env);
            await CancelRemoteEnsureAsync(ct).ConfigureAwait(false);
            SetState(new GatewayEndpointState.Ready(ConnectionMode.Remote, url, token, password));
            return new GatewayEndpointConfig(url, token, password);
        }

        var settings = await _settings.LoadAsync(ct).ConfigureAwait(false);
        (Guid Token, Task<ErrorOr<int>> Task)? ensure;
        await _ensureLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            KickRemoteEnsureIfNeeded(settings, root);
            ensure = _remoteEnsure;
        }
        finally { _ensureLock.Release(); }

        if (ensure is null)
            throw new InvalidOperationException("Connecting\u2026");

        try
        {
            var result      = await ensure.Value.Task.ConfigureAwait(false);
            var stillRemote = ResolveEffectiveMode(
                await _settings.LoadAsync(CancellationToken.None).ConfigureAwait(false),
                OpenClawConfigFile.LoadDict())
                == ConnectionMode.Remote;

            if (!stillRemote) throw new InvalidOperationException("Remote mode is not enabled");

            await _ensureLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                if (_remoteEnsure?.Token == ensure.Value.Token)
                    _remoteEnsure = null;
            }
            finally { _ensureLock.Release(); }

            if (result.IsError) throw new InvalidOperationException(result.FirstError.Description);

            var root2    = OpenClawConfigFile.LoadDict();
            var env2     = GetEnv();
            var scheme   = ResolveGatewayScheme(root2, env2);
            var tok      = ResolveGatewayToken(isRemote: true, root: root2, env: env2);
            var pw       = ResolveGatewayPassword(isRemote: true, root: root2, env: env2);
            var readyUrl = new Uri($"{scheme}://127.0.0.1:{result.Value}");
            SetState(new GatewayEndpointState.Ready(ConnectionMode.Remote, readyUrl, tok, pw));
            return new GatewayEndpointConfig(readyUrl, tok, pw);
        }
        catch (OperationCanceledException)
        {
            await _ensureLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try { if (_remoteEnsure?.Token == ensure.Value.Token) _remoteEnsure = null; }
            finally { _ensureLock.Release(); }
            throw;
        }
        catch (Exception ex) when (ex is not InvalidOperationException)
        {
            await _ensureLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try { if (_remoteEnsure?.Token == ensure.Value.Token) _remoteEnsure = null; }
            finally { _ensureLock.Release(); }
            var msg = $"Remote control tunnel failed ({ex.Message})";
            SetState(new GatewayEndpointState.Unavailable(ConnectionMode.Remote, msg));
            _logger.LogError("remote control tunnel ensure failed {Msg}", msg);
            throw new InvalidOperationException(msg, ex);
        }
    }
}
