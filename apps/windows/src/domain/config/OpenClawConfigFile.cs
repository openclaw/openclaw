using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenClawWindows.Domain.Config;

/// <summary>
/// Config file I/O service
/// Manages openclaw.json: load, save with meta-stamping, audit log, and typed accessors.
/// </summary>
public static class OpenClawConfigFile
{
    private const string ConfigAuditFileName  = "config-audit.jsonl";
    private const string AuditSource          = "windows-openclaw-config-file";
    private const string AuditEventWrite      = "config.write";

    // Tunables
    private const int SuspiciousSizeThreshold = 512;

    // ── Path resolution ───────────────────────────────────────────────────────
    // Env-var overrides (N0-10, not yet implemented).

    public static string ConfigPath()
    {
        var envOverride = Environment.GetEnvironmentVariable("OPENCLAW_CONFIG_PATH");
        if (!string.IsNullOrWhiteSpace(envOverride)) return envOverride;

        return Path.Combine(StateDirPath(), "openclaw.json");
    }

    public static string StateDirPath()
    {
        var envOverride = Environment.GetEnvironmentVariable("OPENCLAW_STATE_DIR");
        if (!string.IsNullOrWhiteSpace(envOverride)) return envOverride;

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OpenClaw");
    }

    public static string DefaultWorkspacePath()
        // user's home directory
        => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    // ── Core load / save ──────────────────────────────────────────────────────

    public static Dictionary<string, object?> LoadDict()
    {
        var path = ConfigPath();
        if (!File.Exists(path)) return [];

        try
        {
            var text = File.ReadAllText(path);
            return ParseConfigText(text) ?? [];
        }
        catch (Exception)
        {
            return [];
        }
    }

    public static void SaveDict(Dictionary<string, object?> dict)
    {
        var path = ConfigPath();
        var previousText  = TryReadFile(path);
        var previousDict  = previousText is not null ? ParseConfigText(previousText) : null;
        var previousBytes = previousText is not null ? System.Text.Encoding.UTF8.GetByteCount(previousText) : (int?)null;
        var hadMetaBefore = HasMeta(previousDict);
        var gatewayModeBefore = GatewayMode(previousDict);

        var output = new Dictionary<string, object?>(dict);
        StampMeta(output);

        try
        {
            var json = SerializeSorted(output);
            var nextBytes = System.Text.Encoding.UTF8.GetByteCount(json);

            Directory.CreateDirectory(Path.GetDirectoryName(path)!);

            // Atomic write via temp file → rename
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, json);
            File.Move(tmp, path, overwrite: true);

            var gatewayModeAfter = GatewayMode(output);
            var suspicious = ConfigWriteSuspiciousReasons(
                existsBefore: previousText is not null,
                previousBytes: previousBytes,
                nextBytes: nextBytes,
                hadMetaBefore: hadMetaBefore,
                gatewayModeBefore: gatewayModeBefore,
                gatewayModeAfter: gatewayModeAfter);

            AppendConfigWriteAudit(new Dictionary<string, object?>
            {
                ["result"]            = "success",
                ["configPath"]        = path,
                ["existsBefore"]      = previousText is not null,
                ["previousBytes"]     = (object?)previousBytes,
                ["nextBytes"]         = nextBytes,
                ["hasMetaBefore"]     = hadMetaBefore,
                ["hasMetaAfter"]      = HasMeta(output),
                ["gatewayModeBefore"] = gatewayModeBefore,
                ["gatewayModeAfter"]  = gatewayModeAfter,
                ["suspicious"]        = suspicious,
            });
        }
        catch (Exception ex)
        {
            AppendConfigWriteAudit(new Dictionary<string, object?>
            {
                ["result"]            = "failed",
                ["configPath"]        = path,
                ["existsBefore"]      = previousText is not null,
                ["previousBytes"]     = (object?)previousBytes,
                ["nextBytes"]         = null,
                ["hasMetaBefore"]     = hadMetaBefore,
                ["hasMetaAfter"]      = HasMeta(output),
                ["gatewayModeBefore"] = gatewayModeBefore,
                ["gatewayModeAfter"]  = GatewayMode(output),
                ["suspicious"]        = Array.Empty<string>(),
                ["error"]             = ex.Message,
            });
        }
    }

    // ── Section accessors ─────────────────────────────────────────────────────

    public static Dictionary<string, object?> LoadGatewayDict()
        => AsDict(LoadDict(), "gateway") ?? [];

    public static void UpdateGatewayDict(Action<Dictionary<string, object?>> mutate)
    {
        var root    = LoadDict();
        var gateway = AsDict(root, "gateway") ?? [];

        mutate(gateway);

        if (gateway.Count == 0)
            root.Remove("gateway");
        else
            root["gateway"] = gateway;

        SaveDict(root);
    }

    // Checks ~/.openclaw/openclaw.json (gateway config), not the app config.
    public static bool ShouldSkipWizard()
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".openclaw", "openclaw.json");
            if (!File.Exists(path)) return false;

            var text = File.ReadAllText(path);
            if (ParseConfigText(text) is not { } root) return false;

            if (AsDict(root, "wizard") is { Count: > 0 }) return true;

            var gateway = AsDict(root, "gateway");
            if (gateway is null) return false;
            var auth = AsDict(gateway, "auth");
            if (auth is null) return false;

            return !string.IsNullOrWhiteSpace(auth.GetValueOrDefault("mode") as string)
                || !string.IsNullOrWhiteSpace(auth.GetValueOrDefault("token") as string)
                || !string.IsNullOrWhiteSpace(auth.GetValueOrDefault("password") as string);
        }
        catch { return false; }
    }

    // Reads gateway.auth.token from ~/.openclaw/openclaw.json.
    // Used as fallback when the GatewayEndpointUri doesn't embed the token in user-info.
    public static string? ReadGatewayAuthToken()
    {
        try
        {
            var gatewayConfigPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".openclaw", "openclaw.json");

            if (!File.Exists(gatewayConfigPath)) return null;

            var text = File.ReadAllText(gatewayConfigPath);
            var dict = ParseConfigText(text);
            if (dict is null) return null;

            var gateway = AsDict(dict, "gateway");
            if (gateway is null) return null;

            var auth = AsDict(gateway, "auth");
            var token = auth?.GetValueOrDefault("token") as string;
            return string.IsNullOrWhiteSpace(token) ? null : token.Trim();
        }
        catch
        {
            return null;
        }
    }

    // ── Browser control ───────────────────────────────────────────────────────

    public static bool BrowserControlEnabled(bool defaultValue = true)
    {
        var root    = LoadDict();
        var browser = AsDict(root, "browser");
        return browser?["enabled"] is bool b ? b : defaultValue;
    }

    public static void SetBrowserControlEnabled(bool enabled)
    {
        var root    = LoadDict();
        var browser = AsDict(root, "browser") ?? [];
        browser["enabled"] = enabled;
        root["browser"]    = browser;
        SaveDict(root);
    }

    // ── Agent workspace ───────────────────────────────────────────────────────
    // Inlined from AgentWorkspaceConfig (N1-15) — reads/writes agents.defaults.workspace.

    public static string? AgentWorkspace()
    {
        var root     = LoadDict();
        var agents   = AsDict(root, "agents");
        var defaults = agents is not null ? AsDict(agents, "defaults") : null;
        return defaults?["workspace"] as string;
    }

    public static void SetAgentWorkspace(string? workspace)
    {
        var root     = LoadDict();
        var agents   = AsDict(root, "agents") ?? [];
        var defaults = AsDict(agents, "defaults") ?? [];

        if (string.IsNullOrWhiteSpace(workspace))
            defaults.Remove("workspace");
        else
            defaults["workspace"] = workspace;

        if (defaults.Count == 0)
            agents.Remove("defaults");
        else
            agents["defaults"] = defaults;

        if (agents.Count == 0)
            root.Remove("agents");
        else
            root["agents"] = agents;

        SaveDict(root);
    }

    // ── Gateway config ────────────────────────────────────────────────────────

    public static string? GatewayPassword()
    {
        var root    = LoadDict();
        var gateway = AsDict(root, "gateway");
        var remote  = gateway is not null ? AsDict(gateway, "remote") : null;
        return remote?["password"] as string;
    }

    // Handles Int, long, double, and string
    public static int? GatewayPort()
    {
        var root    = LoadDict();
        var gateway = AsDict(root, "gateway");
        if (gateway is null) return null;

        var raw = gateway.GetValueOrDefault("port");
        return raw switch
        {
            int i when i > 0    => i,
            long l when l > 0   => (int)l,
            double d when d > 0 => (int)d,
            string s when int.TryParse(s.Trim(), out var p) && p > 0 => p,
            _ => null,
        };
    }

    public static int? RemoteGatewayPort()
    {
        var url = RemoteGatewayUrl();
        if (url is null) return null;
        return url.Port > 0 ? url.Port : null;
    }

    public static int? RemoteGatewayPort(string sshHost)
    {
        var trimmedSshHost = sshHost.Trim();
        if (string.IsNullOrEmpty(trimmedSshHost)) return null;

        var url = RemoteGatewayUrl();
        if (url is null || url.Port <= 0) return null;

        var urlHost = url.Host?.Trim();
        if (string.IsNullOrEmpty(urlHost)) return null;

        var sshKey = HostKey(trimmedSshHost);
        var urlKey = HostKey(urlHost);
        if (string.IsNullOrEmpty(sshKey) || string.IsNullOrEmpty(urlKey)) return null;
        if (sshKey != urlKey) return null;

        return url.Port;
    }

    public static void SetRemoteGatewayUrl(string host, int? port)
    {
        if (port is null || port <= 0) return;
        var trimmedHost = host.Trim();
        if (string.IsNullOrEmpty(trimmedHost)) return;

        UpdateGatewayDict(gateway =>
        {
            var remote      = AsDict(gateway, "remote") ?? [];
            var existingUrl = (remote.GetValueOrDefault("url") as string)?.Trim() ?? "";
            var scheme      = Uri.TryCreate(existingUrl, UriKind.Absolute, out var u) ? u.Scheme : "ws";
            remote["url"]   = $"{scheme}://{trimmedHost}:{port}";
            gateway["remote"] = remote;
        });
    }

    public static void ClearRemoteGatewayUrl()
    {
        UpdateGatewayDict(gateway =>
        {
            var remote = AsDict(gateway, "remote");
            if (remote is null || !remote.ContainsKey("url")) return;

            remote.Remove("url");
            if (remote.Count == 0)
                gateway.Remove("remote");
            else
                gateway["remote"] = remote;
        });
    }

    // Normalizes a host for comparison
    // Returns first domain label (e.g. "gateway.ts.net" → "gateway") so partial
    // host matches resolve to the same key.
    public static string HostKey(string host)
    {
        var trimmed = host.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(trimmed)) return string.Empty;

        // IPv6 — return as-is
        if (trimmed.Contains(':')) return trimmed;

        // IPv4 (only digits and dots) — return as-is
        if (trimmed.All(c => char.IsDigit(c) || c == '.')) return trimmed;

        // Hostname — return first label
        var dotIdx = trimmed.IndexOf('.');
        return dotIdx > 0 ? trimmed[..dotIdx] : trimmed;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private static Uri? RemoteGatewayUrl()
    {
        var root    = LoadDict();
        var gateway = AsDict(root, "gateway");
        var remote  = gateway is not null ? AsDict(gateway, "remote") : null;
        var raw     = remote?.GetValueOrDefault("url") as string;

        var trimmed = raw?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;

        return Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) ? uri : null;
    }

    private static Dictionary<string, object?>? ParseConfigText(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            return ElementToDict(doc.RootElement);
        }
        catch
        {
            return null;
        }
    }

    private static void StampMeta(Dictionary<string, object?> root)
    {
        var meta    = AsDict(root, "meta") ?? [];
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "windows-app";
        meta["lastTouchedVersion"] = version;
        meta["lastTouchedAt"]      = DateTimeOffset.UtcNow.ToString("O");
        root["meta"] = meta;
    }

    private static bool HasMeta(Dictionary<string, object?>? root)
        => root is not null && AsDict(root, "meta") is not null;

    private static string? GatewayMode(Dictionary<string, object?>? root)
    {
        if (root is null) return null;
        var gateway = AsDict(root, "gateway");
        var mode    = gateway?.GetValueOrDefault("mode") as string;
        var trimmed = mode?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static List<string> ConfigWriteSuspiciousReasons(
        bool existsBefore,
        int? previousBytes,
        int nextBytes,
        bool hadMetaBefore,
        string? gatewayModeBefore,
        string? gatewayModeAfter)
    {
        var reasons = new List<string>();
        if (!existsBefore) return reasons;

        if (previousBytes is { } pb && pb >= SuspiciousSizeThreshold
            && nextBytes < Math.Max(1, pb / 2))
            reasons.Add($"size-drop:{pb}->{nextBytes}");

        if (!hadMetaBefore)
            reasons.Add("missing-meta-before-write");

        if (gatewayModeBefore is not null && gatewayModeAfter is null)
            reasons.Add("gateway-mode-removed");

        return reasons;
    }

    private static string ConfigAuditLogPath()
        => Path.Combine(StateDirPath(), "logs", ConfigAuditFileName);

    private static void AppendConfigWriteAudit(Dictionary<string, object?> fields)
    {
        try
        {
            var record = new Dictionary<string, object?>
            {
                ["ts"]     = DateTimeOffset.UtcNow.ToString("O"),
                ["source"] = AuditSource,
                ["event"]  = AuditEventWrite,
                ["pid"]    = Environment.ProcessId,
                ["argv"]   = Environment.GetCommandLineArgs().Take(8).ToArray(),
            };
            foreach (var kvp in fields)
                record[kvp.Key] = kvp.Value;

            var line = JsonSerializer.Serialize(record) + "\n";

            var logPath = ConfigAuditLogPath();
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            File.AppendAllText(logPath, line);
        }
        catch
        {
            // best-effort
        }
    }

    // ── JSON helpers ──────────────────────────────────────────────────────────

    private static string SerializeSorted(Dictionary<string, object?> dict)
        => ToJsonObject(dict).ToJsonString(new JsonSerializerOptions { WriteIndented = true });

    private static JsonObject ToJsonObject(Dictionary<string, object?> dict)
    {
        var obj = new JsonObject();
        foreach (var key in dict.Keys.OrderBy(k => k, StringComparer.Ordinal))
            obj[key] = ValueToJsonNode(dict[key]);
        return obj;
    }

    private static JsonNode? ValueToJsonNode(object? value) => value switch
    {
        Dictionary<string, object?> d => ToJsonObject(d),
        IEnumerable<object?> list     => new JsonArray([.. list.Select(ValueToJsonNode)]),
        string s                      => JsonValue.Create(s),
        bool b                        => JsonValue.Create(b),
        int i                         => JsonValue.Create(i),
        long l                        => JsonValue.Create(l),
        double d                      => JsonValue.Create(d),
        _                             => null,
    };

    private static Dictionary<string, object?> ElementToDict(JsonElement el)
    {
        var dict = new Dictionary<string, object?>();
        foreach (var prop in el.EnumerateObject())
            dict[prop.Name] = ElementToValue(prop.Value);
        return dict;
    }

    private static object? ElementToValue(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Object => ElementToDict(el),
        JsonValueKind.Array  => el.EnumerateArray().Select(ElementToValue).ToList(),
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Number => el.TryGetInt64(out var i) ? (object?)i : el.GetDouble(),
        JsonValueKind.True   => true,
        JsonValueKind.False  => false,
        _                    => null,
    };

    private static Dictionary<string, object?>? AsDict(Dictionary<string, object?> root, string key)
        => root.GetValueOrDefault(key) as Dictionary<string, object?>;

    private static string? TryReadFile(string path)
    {
        try { return File.Exists(path) ? File.ReadAllText(path) : null; }
        catch { return null; }
    }
}
