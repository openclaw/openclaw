using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using ErrorOr;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Infrastructure.ExecApprovals;

/// <summary>
/// Persists exec-approval config to %APPDATA%\OpenClaw\exec-approvals.json.
/// </summary>
internal sealed class JsonExecApprovalsRepository : IExecApprovalsRepository
{
    // Tunables
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OpenClaw", "exec-approvals.json");

    // Windows named pipe path (macOS uses a UNIX socket).
    private const string DefaultPipePath = @"\\.\pipe\openclaw-approvals";
    private const string DefaultAgentId = "main";
    private static readonly ExecSecurity DefaultSecurity = ExecSecurity.Deny;
    private static readonly ExecAsk DefaultAsk = ExecAsk.OnMiss;
    private static readonly ExecSecurity DefaultAskFallback = ExecSecurity.Deny;
    private const bool DefaultAutoAllowSkills = false;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    private readonly ILogger<JsonExecApprovalsRepository> _logger;

    public JsonExecApprovalsRepository(ILogger<JsonExecApprovalsRepository> logger)
    {
        _logger = logger;
    }

    public async Task<ExecApprovalConfig> LoadAsync(CancellationToken ct)
    {
        // Simplified mapping for EvaluateExecRequestHandler until GAP-047 replaces it.
        var resolved = await ResolveAsync(null, ct);
        var requireApproval = resolved.Agent.Security != ExecSecurity.Full;
        var allowlist = resolved.Allowlist.Select(e => e.Pattern).ToArray();
        var result = ExecApprovalConfig.Create(requireApproval, allowlist, [], [], 65536);
        return result.IsError ? ExecApprovalConfig.DenyAll() : result.Value;
    }

    public async Task<ExecApprovalsResolved> ResolveAsync(string? agentId, CancellationToken ct)
    {
        var file = await EnsureFileAsync(ct);
        return Resolve(file, agentId);
    }

    public async Task<ExecApprovalsSnapshot> GetSnapshotAsync(CancellationToken ct)
    {
        _ = await EnsureFileAsync(ct);
        var snapshot = ReadSnapshot();
        // Strip token before returning to callers — token is only used by exec-host IPC internally.
        return snapshot with { File = RedactForSnapshot(snapshot.File) };
    }

    public async Task ApplyFileAsync(ExecApprovalsFile incoming, string? baseHash, CancellationToken ct)
    {
        var snapshot = ReadSnapshot();

        // Hash-based conflict detection
        if (snapshot.Exists)
        {
            if (string.IsNullOrEmpty(snapshot.Hash))
                throw new InvalidOperationException("exec approvals base hash unavailable; reload and retry");
            var trimmedHash = baseHash?.Trim() ?? "";
            if (trimmedHash.Length == 0)
                throw new InvalidOperationException("exec approvals base hash required; reload and retry");
            if (trimmedHash != snapshot.Hash)
                throw new InvalidOperationException("exec approvals changed; reload and retry");
        }

        var current = await EnsureFileAsync(ct);
        var normalized = NormalizeIncoming(incoming);

        // Preserve pipe path and token from current file unless explicitly provided in incoming.
        var resolvedPath = string.IsNullOrWhiteSpace(normalized.Socket?.Path)
            ? (string.IsNullOrWhiteSpace(current.Socket?.Path) ? DefaultPipePath : current.Socket!.Path!)
            : normalized.Socket!.Path!;
        var resolvedToken = string.IsNullOrWhiteSpace(normalized.Socket?.Token)
            ? (current.Socket?.Token?.Trim() ?? "")
            : normalized.Socket!.Token!;

        normalized = normalized with
        {
            Socket = new ExecApprovalsSocketConfig { Path = resolvedPath, Token = resolvedToken },
        };

        await SaveFileAsync(normalized, ct);
    }

    private static ExecApprovalsResolved Resolve(ExecApprovalsFile file, string? agentId)
    {
        var defaults = file.Defaults ?? new ExecApprovalsDefaults();
        var resolvedDefaults = new ExecApprovalsResolvedDefaults
        {
            Security = defaults.Security ?? DefaultSecurity,
            Ask = defaults.Ask ?? DefaultAsk,
            AskFallback = defaults.AskFallback ?? DefaultAskFallback,
            AutoAllowSkills = defaults.AutoAllowSkills ?? DefaultAutoAllowSkills,
        };

        var key = AgentKey(agentId);
        var agentEntry = file.Agents?.GetValueOrDefault(key) ?? new ExecApprovalsAgent();
        var wildcardEntry = file.Agents?.GetValueOrDefault("*") ?? new ExecApprovalsAgent();

        var resolvedAgent = new ExecApprovalsResolvedDefaults
        {
            Security = agentEntry.Security ?? wildcardEntry.Security ?? resolvedDefaults.Security,
            Ask = agentEntry.Ask ?? wildcardEntry.Ask ?? resolvedDefaults.Ask,
            AskFallback = agentEntry.AskFallback ?? wildcardEntry.AskFallback ?? resolvedDefaults.AskFallback,
            AutoAllowSkills = agentEntry.AutoAllowSkills ?? wildcardEntry.AutoAllowSkills ?? resolvedDefaults.AutoAllowSkills,
        };

        var combined = (wildcardEntry.Allowlist ?? []).Concat(agentEntry.Allowlist ?? []).ToList();
        var allowlist = NormalizeAllowlistEntries(combined, dropInvalid: true).Entries;

        return new ExecApprovalsResolved
        {
            PipePath = ExpandPath(file.Socket?.Path ?? DefaultPipePath),
            Token = file.Socket?.Token ?? "",
            Defaults = resolvedDefaults,
            Agent = resolvedAgent,
            Allowlist = allowlist,
            File = file,
        };
    }

    private static ExecApprovalsSnapshot ReadSnapshot()
    {
        if (!File.Exists(FilePath))
        {
            return new ExecApprovalsSnapshot
            {
                Path = FilePath,
                Exists = false,
                Hash = HashRaw(null),
                File = new ExecApprovalsFile { Version = 1 },
            };
        }

        string? raw = null;
        try { raw = File.ReadAllText(FilePath, Encoding.UTF8); }
        catch { /* fall through to empty */ }

        ExecApprovalsFile decoded;
        try
        {
            decoded = (raw is not null
                ? JsonSerializer.Deserialize<ExecApprovalsFile>(raw, JsonOptions)
                : null) ?? new ExecApprovalsFile { Version = 1 };
        }
        catch (JsonException)
        {
            decoded = new ExecApprovalsFile { Version = 1 };
        }

        return new ExecApprovalsSnapshot
        {
            Path = FilePath,
            Exists = true,
            Hash = HashRaw(raw),
            File = decoded,
        };
    }

    private async Task<ExecApprovalsFile> EnsureFileAsync(CancellationToken ct)
    {
        var existed = File.Exists(FilePath);
        var loaded = LoadFile();
        var loadedHash = HashFile(loaded);

        var file = NormalizeIncoming(loaded);
        file = file with
        {
            Socket = new ExecApprovalsSocketConfig
            {
                Path = string.IsNullOrWhiteSpace(file.Socket?.Path) ? DefaultPipePath : file.Socket!.Path,
                Token = string.IsNullOrWhiteSpace(file.Socket?.Token) ? GenerateToken() : file.Socket!.Token,
            },
            Agents = file.Agents ?? new Dictionary<string, ExecApprovalsAgent>(),
        };

        if (!existed || loadedHash != HashFile(file))
            await SaveFileAsync(file, ct);

        return file;
    }

    private ExecApprovalsFile LoadFile()
    {
        if (!File.Exists(FilePath))
            return new ExecApprovalsFile { Version = 1 };
        try
        {
            var raw = File.ReadAllText(FilePath, Encoding.UTF8);
            var decoded = JsonSerializer.Deserialize<ExecApprovalsFile>(raw, JsonOptions);
            if (decoded is null || decoded.Version != 1)
                return new ExecApprovalsFile { Version = 1 };
            return decoded;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("exec approvals load failed: {Message}", ex.Message);
            return new ExecApprovalsFile { Version = 1 };
        }
    }

    private async Task SaveFileAsync(ExecApprovalsFile file, CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var json = JsonSerializer.Serialize(file, JsonOptions);
            var tmp = FilePath + ".tmp";
            await File.WriteAllTextAsync(tmp, json, Encoding.UTF8, ct);
            // Atomic rename on NTFS (same volume)
            File.Move(tmp, FilePath, overwrite: true);
        }
        catch (Exception ex)
        {
            _logger.LogError("exec approvals save failed: {Message}", ex.Message);
        }
    }

    private static ExecApprovalsFile NormalizeIncoming(ExecApprovalsFile file)
    {
        var socketPath = file.Socket?.Path?.Trim() ?? "";
        var token = file.Socket?.Token?.Trim() ?? "";
        var agents = new Dictionary<string, ExecApprovalsAgent>(file.Agents ?? []);

        // Migrate legacy "default" agent key to "main"
        if (agents.TryGetValue("default", out var legacyDefault))
        {
            if (agents.TryGetValue(DefaultAgentId, out var main))
                agents[DefaultAgentId] = MergeAgents(main, legacyDefault);
            else
                agents[DefaultAgentId] = legacyDefault;
            agents.Remove("default");
        }

        var normalized = new Dictionary<string, ExecApprovalsAgent>(agents.Count);
        foreach (var (key, agent) in agents)
        {
            if (agent.Allowlist is { Count: > 0 } rawList)
            {
                var entries = NormalizeAllowlistEntries(rawList, dropInvalid: false).Entries;
                normalized[key] = agent with { Allowlist = entries.Count == 0 ? null : entries };
            }
            else
            {
                normalized[key] = agent;
            }
        }

        return new ExecApprovalsFile
        {
            Version = 1,
            Socket = new ExecApprovalsSocketConfig
            {
                Path = socketPath.Length == 0 ? null : socketPath,
                Token = token.Length == 0 ? null : token,
            },
            Defaults = file.Defaults,
            Agents = normalized.Count == 0 ? null : normalized,
        };
    }

    internal static ExecApprovalsFile RedactForSnapshot(ExecApprovalsFile file)
    {
        var socketPath = file.Socket?.Path?.Trim() ?? "";
        if (socketPath.Length == 0)
            return file with { Socket = null };
        // Strip token — callers must not receive the pipe token via the gateway.
        return file with { Socket = new ExecApprovalsSocketConfig { Path = socketPath, Token = null } };
    }

    private static (List<ExecAllowlistEntry> Entries, List<ExecAllowlistRejectedEntry> Rejected)
        NormalizeAllowlistEntries(List<ExecAllowlistEntry> entries, bool dropInvalid)
    {
        var normalized = new List<ExecAllowlistEntry>(entries.Count);
        var rejected = new List<ExecAllowlistRejectedEntry>();

        foreach (var entry in entries)
        {
            var migrated = MigrateLegacyPattern(entry);
            var trimmedPattern = migrated.Pattern.Trim();
            var trimmedResolved = migrated.LastResolvedPath?.Trim();
            var normalizedResolved = string.IsNullOrEmpty(trimmedResolved) ? null : trimmedResolved;

            switch (ExecApprovalHelpers.ValidateAllowlistPattern(trimmedPattern))
            {
                case ExecAllowlistPatternValidation.Valid valid:
                    normalized.Add(migrated with { Pattern = valid.Pattern, LastResolvedPath = normalizedResolved });
                    break;
                case ExecAllowlistPatternValidation.Invalid invalid:
                    if (dropInvalid)
                        rejected.Add(new ExecAllowlistRejectedEntry(migrated.Id, trimmedPattern, invalid.Reason));
                    else if (invalid.Reason != ExecAllowlistPatternValidationReason.Empty)
                        normalized.Add(migrated with { Pattern = trimmedPattern, LastResolvedPath = normalizedResolved });
                    break;
            }
        }

        return (normalized, rejected);
    }

    private static ExecAllowlistEntry MigrateLegacyPattern(ExecAllowlistEntry entry)
    {
        var trimmedPattern = entry.Pattern.Trim();
        var trimmedResolved = entry.LastResolvedPath?.Trim() ?? "";
        var normalizedResolved = trimmedResolved.Length == 0 ? null : trimmedResolved;

        switch (ExecApprovalHelpers.ValidateAllowlistPattern(trimmedPattern))
        {
            case ExecAllowlistPatternValidation.Valid valid:
                return entry with { Pattern = valid.Pattern, LastResolvedPath = normalizedResolved };
            case ExecAllowlistPatternValidation.Invalid:
                // Try to recover pattern from lastResolvedPath
                switch (ExecApprovalHelpers.ValidateAllowlistPattern(trimmedResolved))
                {
                    case ExecAllowlistPatternValidation.Valid migratedValid:
                        return entry with { Pattern = migratedValid.Pattern, LastResolvedPath = normalizedResolved };
                    default:
                        return entry with { Pattern = trimmedPattern, LastResolvedPath = normalizedResolved };
                }
            default:
                return entry with { Pattern = trimmedPattern, LastResolvedPath = normalizedResolved };
        }
    }

    private static ExecApprovalsAgent MergeAgents(ExecApprovalsAgent current, ExecApprovalsAgent legacy)
    {
        var currentList = NormalizeAllowlistEntries(current.Allowlist?.ToList() ?? [], dropInvalid: false).Entries;
        var legacyList = NormalizeAllowlistEntries(legacy.Allowlist?.ToList() ?? [], dropInvalid: false).Entries;

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var allowlist = new List<ExecAllowlistEntry>();

        void Append(ExecAllowlistEntry e)
        {
            // Dedup by normalized (lowercased) pattern
            var key = e.Pattern.Trim().ToLowerInvariant();
            if (!seen.Add(key)) return;
            allowlist.Add(e);
        }

        foreach (var e in currentList) Append(e);
        foreach (var e in legacyList) Append(e);

        return new ExecApprovalsAgent
        {
            Security = current.Security ?? legacy.Security,
            Ask = current.Ask ?? legacy.Ask,
            AskFallback = current.AskFallback ?? legacy.AskFallback,
            AutoAllowSkills = current.AutoAllowSkills ?? legacy.AutoAllowSkills,
            Allowlist = allowlist.Count == 0 ? null : allowlist,
        };
    }

    private static string AgentKey(string? agentId)
    {
        var trimmed = agentId?.Trim() ?? "";
        return trimmed.Length == 0 ? DefaultAgentId : trimmed;
    }

    private static string ExpandPath(string raw)
    {
        var trimmed = raw.Trim();
        if (trimmed == "~")
            return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (trimmed.StartsWith("~/"))
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), trimmed[2..]);
        return trimmed;
    }

    private static string HashRaw(string? raw)
    {
        var data = Encoding.UTF8.GetBytes(raw ?? "");
        return Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
    }

    private static string HashFile(ExecApprovalsFile file)
    {
        // Sort agent keys for deterministic hashing
        var sortedAgents = file.Agents is { Count: > 0 }
            ? file.Agents.OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .ToDictionary(kv => kv.Key, kv => kv.Value)
            : file.Agents;
        var fileForHash = file with { Agents = sortedAgents };
        var json = JsonSerializer.Serialize(fileForHash, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        });
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
    }

    // 24 random bytes encoded as URL-safe base64 (no padding)
    private static string GenerateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(24);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }
}
