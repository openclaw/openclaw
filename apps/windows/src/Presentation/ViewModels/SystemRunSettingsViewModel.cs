using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using OpenClawWindows.Application.ExecApprovals;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Presentation.ViewModels;

/// <summary>
/// Manages exec-approval policy and per-agent allowlist editing.
/// </summary>
internal sealed partial class SystemRunSettingsViewModel : ObservableObject
{
    private const string DefaultsScopeId = "__defaults__";
    private const string FallbackAgentId = "main";

    private readonly ISender _sender;
    private readonly IConfigStore _configStore;

    private string? _snapshotHash;
    private ExecApprovalsFile _currentFile = new() { Version = 1 };

    [ObservableProperty] private List<string> _agentIds = [FallbackAgentId];
    [ObservableProperty] private string _selectedAgentId = FallbackAgentId;
    [ObservableProperty] private string _defaultAgentId = FallbackAgentId;
    [ObservableProperty] private ExecSecurity _security = ExecSecurity.Deny;
    [ObservableProperty] private ExecAsk _ask = ExecAsk.OnMiss;
    [ObservableProperty] private ExecSecurity _askFallback = ExecSecurity.Deny;
    [ObservableProperty] private bool _autoAllowSkills;
    [ObservableProperty] private string? _allowlistValidationMessage;
    [ObservableProperty] private bool _isLoading;

    internal ObservableCollection<AllowlistEntryRow> Entries { get; } = [];

    // No SkillBinsCache in Windows
    internal IReadOnlyList<string> SkillBins { get; } = [];

    // prepends "__defaults__" sentinel before real agent IDs.
    internal List<string> AgentPickerIds => [DefaultsScopeId, .. AgentIds];

    internal bool IsDefaultsScope => SelectedAgentId == DefaultsScopeId;

    internal string ScopeMessage => IsDefaultsScope
        ? "Defaults apply when an agent has no overrides. " +
          "Ask controls prompt behavior; fallback is used when no companion UI is reachable."
        : "Security controls whether system.run can execute when paired as a node. " +
          "Ask controls prompt behavior; fallback is used when no companion UI is reachable.";

    public SystemRunSettingsViewModel(ISender sender, IConfigStore configStore)
    {
        _sender      = sender;
        _configStore = configStore;
    }

    internal async Task RefreshAsync(CancellationToken ct = default)
    {
        IsLoading = true;
        try
        {
            await RefreshAgentsAsync(ct);
            await LoadSnapshotAsync(ct);
            LoadSettingsForAgent(SelectedAgentId);
        }
        finally
        {
            IsLoading = false;
        }
    }

    internal async Task RefreshAgentsAsync(CancellationToken ct = default)
    {
        try
        {
            var root   = await _configStore.LoadAsync(ct);
            var agDict = root.TryGetValue("agents", out var ag) ? ag as Dictionary<string, object?> : null;
            var list   = agDict?.TryGetValue("list", out var l) == true ? l as List<object?> : null;

            var ids     = new List<string>();
            var seen    = new HashSet<string>(StringComparer.Ordinal);
            string? defaultId = null;

            foreach (var item in list ?? [])
            {
                if (item is not Dictionary<string, object?> entry) continue;
                var raw     = entry.TryGetValue("id", out var idVal) ? idVal as string : null;
                var trimmed = raw?.Trim() ?? "";
                if (trimmed.Length == 0 || !seen.Add(trimmed)) continue;
                ids.Add(trimmed);
                if (defaultId is null && entry.TryGetValue("default", out var def) && def is true)
                    defaultId = trimmed;
            }

            if (ids.Count == 0) { ids.Add(FallbackAgentId); defaultId = FallbackAgentId; }
            else { defaultId ??= ids[0]; }

            AgentIds      = ids;
            DefaultAgentId = defaultId;

            if (SelectedAgentId != DefaultsScopeId && !AgentIds.Contains(SelectedAgentId))
                SelectedAgentId = DefaultAgentId;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            AllowlistValidationMessage = ex.Message;
        }
    }

    internal async Task SelectAgentAsync(string id, CancellationToken ct = default)
    {
        SelectedAgentId = id;
        AllowlistValidationMessage = null;
        await LoadSnapshotAsync(ct);
        LoadSettingsForAgent(id);
    }

    internal void LoadSettingsForAgent(string agentId)
    {
        AllowlistValidationMessage = null;
        if (agentId == DefaultsScopeId)
        {
            var d    = _currentFile.Defaults ?? new ExecApprovalsDefaults();
            Security = d.Security     ?? ExecSecurity.Deny;
            Ask      = d.Ask          ?? ExecAsk.OnMiss;
            AskFallback = d.AskFallback ?? ExecSecurity.Deny;
            AutoAllowSkills = d.AutoAllowSkills ?? false;
            Entries.Clear();
            return;
        }

        var agent = _currentFile.Agents?.GetValueOrDefault(agentId) ?? new ExecApprovalsAgent();
        var defs  = _currentFile.Defaults ?? new ExecApprovalsDefaults();
        Security    = agent.Security        ?? defs.Security     ?? ExecSecurity.Deny;
        Ask         = agent.Ask             ?? defs.Ask          ?? ExecAsk.OnMiss;
        AskFallback = agent.AskFallback     ?? defs.AskFallback  ?? ExecSecurity.Deny;
        AutoAllowSkills = agent.AutoAllowSkills ?? defs.AutoAllowSkills ?? false;

        Entries.Clear();
        foreach (var e in (agent.Allowlist ?? []).OrderBy(e => e.Pattern, StringComparer.OrdinalIgnoreCase))
            Entries.Add(new AllowlistEntryRow
            {
                Id               = e.Id,
                Pattern          = e.Pattern,
                LastUsedAt       = e.LastUsedAt,
                LastUsedCommand  = e.LastUsedCommand,
                LastResolvedPath = e.LastResolvedPath
            });
    }

    internal async Task SetSecurityAsync(ExecSecurity security, CancellationToken ct = default)
    {
        Security = security;
        await PersistSettingsAsync(ct);
    }

    internal async Task SetAskAsync(ExecAsk ask, CancellationToken ct = default)
    {
        Ask = ask;
        await PersistSettingsAsync(ct);
    }

    internal async Task SetAskFallbackAsync(ExecSecurity mode, CancellationToken ct = default)
    {
        AskFallback = mode;
        await PersistSettingsAsync(ct);
    }

    internal async Task SetAutoAllowSkillsAsync(bool enabled, CancellationToken ct = default)
    {
        AutoAllowSkills = enabled;
        await PersistSettingsAsync(ct);
    }

    internal async Task<ExecAllowlistPatternValidationReason?> AddEntryAsync(string pattern, CancellationToken ct = default)
    {
        if (IsDefaultsScope) return null;
        switch (ExecApprovalHelpers.ValidateAllowlistPattern(pattern))
        {
            case ExecAllowlistPatternValidation.Valid v:
                Entries.Add(new AllowlistEntryRow { Id = Guid.NewGuid(), Pattern = v.Pattern });
                return await PersistAllowlistAsync(ct);
            case ExecAllowlistPatternValidation.Invalid i:
                AllowlistValidationMessage = ValidationMessage(i.Reason);
                return i.Reason;
            default: return null;
        }
    }

    internal async Task<ExecAllowlistPatternValidationReason?> UpdateEntryAsync(
        Guid id, string newPattern, CancellationToken ct = default)
    {
        if (IsDefaultsScope) return null;
        var idx = Entries.ToList().FindIndex(e => e.Id == id);
        if (idx < 0) return null;
        switch (ExecApprovalHelpers.ValidateAllowlistPattern(newPattern))
        {
            case ExecAllowlistPatternValidation.Valid v:
                Entries[idx] = Entries[idx] with { Pattern = v.Pattern };
                return await PersistAllowlistAsync(ct);
            case ExecAllowlistPatternValidation.Invalid i:
                AllowlistValidationMessage = ValidationMessage(i.Reason);
                return i.Reason;
            default: return null;
        }
    }

    internal async Task RemoveEntryAsync(Guid id, CancellationToken ct = default)
    {
        if (IsDefaultsScope) return;
        var idx = Entries.ToList().FindIndex(e => e.Id == id);
        if (idx < 0) return;
        Entries.RemoveAt(idx);
        await PersistAllowlistAsync(ct);
    }

    internal bool IsPathPattern(string pattern) => ExecApprovalHelpers.IsPathPattern(pattern);

    internal string Label(string id) => id == DefaultsScopeId ? "Defaults" : id;

    // ── Persistence ──────────────────────────────────────────────────────────

    private async Task LoadSnapshotAsync(CancellationToken ct)
    {
        var result = await _sender.Send(new GetExecApprovalsQuery(), ct);
        if (result.IsError) return;
        _snapshotHash = result.Value.Hash;
        _currentFile  = result.Value.File;
    }

    private async Task PersistSettingsAsync(CancellationToken ct)
    {
        var result = await _sender.Send(new SetExecApprovalsCommand(BuildFile(), _snapshotHash), ct);
        if (result.IsError) return;
        _snapshotHash = result.Value.Hash;
        _currentFile  = result.Value.File;
    }

    private async Task<ExecAllowlistPatternValidationReason?> PersistAllowlistAsync(CancellationToken ct)
    {
        var result = await _sender.Send(new SetExecApprovalsCommand(BuildFile(), _snapshotHash), ct);
        if (result.IsError) { AllowlistValidationMessage = result.FirstError.Description; return null; }
        _snapshotHash = result.Value.Hash;
        _currentFile  = result.Value.File;
        AllowlistValidationMessage = GetRejectedMessage(result.Value.File);
        return null;
    }

    private ExecApprovalsFile BuildFile()
    {
        if (IsDefaultsScope)
        {
            return _currentFile with
            {
                Defaults = new ExecApprovalsDefaults
                {
                    Security = Security, Ask = Ask, AskFallback = AskFallback,
                    AutoAllowSkills = AutoAllowSkills
                }
            };
        }

        var agents  = new Dictionary<string, ExecApprovalsAgent>(_currentFile.Agents ?? []);
        var current = agents.TryGetValue(SelectedAgentId, out var ex) ? ex : new ExecApprovalsAgent();
        var allowlist = Entries
            .Select(e => new ExecAllowlistEntry
            {
                Id               = e.Id,
                Pattern          = e.Pattern,
                LastUsedAt       = e.LastUsedAt,
                LastUsedCommand  = e.LastUsedCommand,
                LastResolvedPath = e.LastResolvedPath
            })
            .ToList();
        agents[SelectedAgentId] = current with
        {
            Security        = Security,
            Ask             = Ask,
            AskFallback     = AskFallback,
            AutoAllowSkills = AutoAllowSkills,
            Allowlist       = allowlist.Count == 0 ? null : allowlist
        };
        return _currentFile with { Agents = agents };
    }

    // Returns a validation message if any in-memory entry was rejected during normalization.
    private string? GetRejectedMessage(ExecApprovalsFile savedFile)
    {
        if (IsDefaultsScope) return null;
        var saved   = savedFile.Agents?.GetValueOrDefault(SelectedAgentId);
        var savedPats = new HashSet<string>(
            (saved?.Allowlist ?? []).Select(e => e.Pattern),
            StringComparer.OrdinalIgnoreCase);
        var missing = Entries.FirstOrDefault(e => !savedPats.Contains(e.Pattern));
        return missing is null ? null : $"Pattern '{missing.Pattern}' was rejected (basename only).";
    }

    private static string ValidationMessage(ExecAllowlistPatternValidationReason reason) => reason switch
    {
        ExecAllowlistPatternValidationReason.Empty
            => "Pattern cannot be empty.",
        ExecAllowlistPatternValidationReason.MissingPathComponent
            => "Path patterns only. Basename entries like \"echo\" are ignored.",
        _ => "Invalid pattern."
    };

    // ── Inner types ──────────────────────────────────────────────────────────

    internal sealed record AllowlistEntryRow
    {
        internal required Guid    Id               { get; init; }
        internal required string  Pattern          { get; init; }
        internal          double? LastUsedAt       { get; init; }
        internal          string? LastUsedCommand  { get; init; }
        internal          string? LastResolvedPath { get; init; }
    }
}
