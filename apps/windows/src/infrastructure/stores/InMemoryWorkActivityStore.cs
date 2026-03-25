using System.Text.Json;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.WorkActivity;

namespace OpenClawWindows.Infrastructure.Stores;

/// <summary>
/// Thread-safe implementation of IWorkActivityStore.
/// </summary>
internal sealed class InMemoryWorkActivityStore : IWorkActivityStore
{
    // Tunables
    private static readonly TimeSpan ToolResultGrace = TimeSpan.FromSeconds(2.0);  // avoids flicker on rapid start/result bursts

    private readonly object _lock = new();

    private string _mainSessionKey = "main";
    private readonly Dictionary<string, WorkActivity> _jobs = new();
    private readonly Dictionary<string, WorkActivity> _tools = new();
    private string? _currentSessionKey;
    private readonly Dictionary<string, int> _toolSeqBySession = new();

    private WorkActivity? _current;
    private IconState _iconState = new IconState.Idle();
    private string? _lastToolLabel;
    private DateTimeOffset? _lastToolUpdatedAt;

    public WorkActivity? Current { get { lock (_lock) return _current; } }
    public IconState IconState { get { lock (_lock) return _iconState; } }
    public string? LastToolLabel { get { lock (_lock) return _lastToolLabel; } }
    public DateTimeOffset? LastToolUpdatedAt { get { lock (_lock) return _lastToolUpdatedAt; } }
    public string MainSessionKey { get { lock (_lock) return _mainSessionKey; } }

    public event EventHandler? StateChanged;

    // ── Public API

    public void HandleJob(string sessionKey, string state)
    {
        bool changed;
        lock (_lock)
        {
            var isStart = string.Equals(state, "started", StringComparison.OrdinalIgnoreCase)
                       || string.Equals(state, "streaming", StringComparison.OrdinalIgnoreCase);

            var prevCurrent = _current;
            var prevIcon = _iconState;

            if (isStart)
            {
                var activity = new WorkActivity(
                    SessionKey: sessionKey,
                    Role: RoleFor(sessionKey),
                    Kind: new ActivityKind.Job(),
                    Label: "job",
                    StartedAt: DateTimeOffset.UtcNow,
                    LastUpdate: DateTimeOffset.UtcNow);
                SetJobActive(activity);
            }
            else
            {
                // Job ended (done/error/aborted/etc) — clear both tool and job for this session.
                ClearTool(sessionKey);
                ClearJob(sessionKey);
            }

            changed = !Equals(prevCurrent, _current) || !Equals(prevIcon, _iconState);
        }
        if (changed) FireStateChanged();
    }

    public void HandleTool(string sessionKey, string phase, string? name, string? meta, JsonElement? args)
    {
        bool changed;
        bool scheduleDelayedClear = false;
        int capturedSeq = 0;

        lock (_lock)
        {
            var prevCurrent = _current;
            var prevIcon = _iconState;
            var prevLabel = _lastToolLabel;
            var prevUpdatedAt = _lastToolUpdatedAt;

            if (string.Equals(phase, "start", StringComparison.OrdinalIgnoreCase))
            {
                var label = BuildLabel(name, meta, args);
                _lastToolLabel = label;
                _lastToolUpdatedAt = DateTimeOffset.UtcNow;
                _toolSeqBySession[sessionKey] = _toolSeqBySession.GetValueOrDefault(sessionKey, 0) + 1;

                var activity = new WorkActivity(
                    SessionKey: sessionKey,
                    Role: RoleFor(sessionKey),
                    Kind: new ActivityKind.Tool(ToolKindHelper.From(name)),
                    Label: label,
                    StartedAt: DateTimeOffset.UtcNow,
                    LastUpdate: DateTimeOffset.UtcNow);
                SetToolActive(activity);
            }
            else
            {
                // Delay removal slightly to avoid flicker on rapid result/start bursts.
                capturedSeq = _toolSeqBySession.GetValueOrDefault(sessionKey, 0);
                scheduleDelayedClear = true;
            }

            changed = !Equals(prevCurrent, _current)
                   || !Equals(prevIcon, _iconState)
                   || prevLabel != _lastToolLabel
                   || prevUpdatedAt != _lastToolUpdatedAt;
        }

        if (changed) FireStateChanged();

        if (scheduleDelayedClear)
            ScheduleDelayedToolClear(sessionKey, capturedSeq);
    }

    public void SetMainSessionKey(string sessionKey)
    {
        var trimmed = sessionKey.Trim();
        if (string.IsNullOrEmpty(trimmed)) return;

        bool changed;
        lock (_lock)
        {
            if (trimmed == _mainSessionKey) return;
            var before = (_current, _iconState);

            _mainSessionKey = trimmed;

            // If current session is now inactive, pick a new one.
            if (_currentSessionKey != null && !IsActive(_currentSessionKey))
                PickNextSession();

            RefreshDerivedState();
            changed = !Equals(before.Item1, _current) || !Equals(before._iconState, _iconState);
        }
        if (changed) FireStateChanged();
    }

    public void ResolveIconState(IconOverrideSelection overrideSelection)
    {
        bool changed;
        lock (_lock)
        {
            var old = _iconState;
            // System → revert to auto-derived; otherwise apply override.
            _iconState = overrideSelection == IconOverrideSelection.System
                ? DeriveIconState()
                : ApplyOverride(overrideSelection.ToIconState());
            changed = !Equals(old, _iconState);
        }
        if (changed) FireStateChanged();
    }

    // ── Internal mutations — must be called under _lock ──────────────────────

    private void SetJobActive(WorkActivity activity)
    {
        _jobs[activity.SessionKey] = activity;
        UpdateCurrentSession(activity);
    }

    private void SetToolActive(WorkActivity activity)
    {
        _tools[activity.SessionKey] = activity;
        UpdateCurrentSession(activity);
    }

    private void UpdateCurrentSession(WorkActivity activity)
    {
        // Main session preempts immediately in macOS).
        if (activity.Role == SessionRole.Main)
            _currentSessionKey = activity.SessionKey;
        else if (_currentSessionKey == null || !IsActive(_currentSessionKey))
            _currentSessionKey = activity.SessionKey;

        RefreshDerivedState();
    }

    private void ClearJob(string sessionKey)
    {
        if (!_jobs.Remove(sessionKey)) return;

        if (_currentSessionKey == sessionKey && !IsActive(sessionKey))
            PickNextSession();

        RefreshDerivedState();
    }

    private void ClearTool(string sessionKey)
    {
        if (!_tools.Remove(sessionKey)) return;

        if (_currentSessionKey == sessionKey && !IsActive(sessionKey))
            PickNextSession();

        RefreshDerivedState();
    }

    private void PickNextSession()
    {
        // Prefer main session if active.
        if (IsActive(_mainSessionKey))
        {
            _currentSessionKey = _mainSessionKey;
            return;
        }

        // Otherwise pick most recently updated session across jobs and tools.
        var keys = _jobs.Keys.Concat(_tools.Keys).Distinct();
        _currentSessionKey = keys.MaxBy(LastUpdateFor);
    }

    private void RefreshDerivedState()
    {
        if (_currentSessionKey != null && !IsActive(_currentSessionKey))
            _currentSessionKey = null;

        _current = _currentSessionKey != null ? CurrentActivity(_currentSessionKey) : null;
        _iconState = DeriveIconState();
    }

    private IconState DeriveIconState()
    {
        if (_currentSessionKey == null) return new IconState.Idle();
        var activity = CurrentActivity(_currentSessionKey);
        if (activity == null) return new IconState.Idle();

        // Recompute role dynamically — stored activity.Role is stale after SetMainSessionKey().
        return RoleFor(_currentSessionKey) switch
        {
            SessionRole.Main  => new IconState.WorkingMain(activity.Kind),
            SessionRole.Other => new IconState.WorkingOther(activity.Kind),
            _                 => new IconState.Idle(),
        };
    }

    private static IconState ApplyOverride(IconState baseState) => baseState switch
    {
        IconState.WorkingMain  { Kind: var k } => new IconState.Overridden(k),
        IconState.WorkingOther { Kind: var k } => new IconState.Overridden(k),
        IconState.Overridden   { Kind: var k } => new IconState.Overridden(k),
        _                                      => new IconState.Idle(),
    };

    // ── Helpers ───────────────────────────────────────────────────────────────

    private SessionRole RoleFor(string sessionKey) =>
        sessionKey == _mainSessionKey ? SessionRole.Main : SessionRole.Other;

    private bool IsActive(string? sessionKey) =>
        sessionKey != null && (_jobs.ContainsKey(sessionKey) || _tools.ContainsKey(sessionKey));

    private DateTimeOffset LastUpdateFor(string sessionKey) =>
        new[] {
            _jobs.TryGetValue(sessionKey, out var j)  ? j.LastUpdate  : DateTimeOffset.MinValue,
            _tools.TryGetValue(sessionKey, out var t) ? t.LastUpdate  : DateTimeOffset.MinValue,
        }.Max();

    private WorkActivity? CurrentActivity(string sessionKey) =>
        // Tool overlays job when both are present
        _tools.TryGetValue(sessionKey, out var tool) ? tool :
        _jobs.TryGetValue(sessionKey, out var job)   ? job  : null;

    private void ScheduleDelayedToolClear(string sessionKey, int capturedSeq)
    {
        // Fire-and-forget.
        _ = Task.Run(async () =>
        {
            await Task.Delay(ToolResultGrace);
            bool changed;
            lock (_lock)
            {
                // Abort if a new tool started for this session since the delay was scheduled.
                if (_toolSeqBySession.GetValueOrDefault(sessionKey, 0) != capturedSeq) return;

                var before = (_current, _iconState);
                _lastToolUpdatedAt = DateTimeOffset.UtcNow;
                ClearTool(sessionKey);
                changed = !Equals(before.Item1, _current) || !Equals(before._iconState, _iconState);
            }
            if (changed) FireStateChanged();
        });
    }

    private void FireStateChanged() => StateChanged?.Invoke(this, EventArgs.Empty);

    // ── Label builder — simplified equivalent of ToolDisplayRegistry.resolve() ─

    private static string BuildLabel(string? name, string? meta, JsonElement? args)
    {
        var toolName = name ?? "tool";
        var label = toolName.ToLowerInvariant() switch
        {
            "bash" or "shell" => "Bash",
            "read"            => "Read",
            "write"           => "Write",
            "edit"            => "Edit",
            "attach"          => "Attach",
            _                 => Capitalize(toolName),
        };

        var detail = ExtractDetail(toolName, meta, args);
        return !string.IsNullOrEmpty(detail) ? $"{label}: {detail}" : label;
    }

    private static string? ExtractDetail(string toolName, string? meta, JsonElement? args)
    {
        if (!string.IsNullOrEmpty(meta)) return Truncate(meta);
        if (args is null) return null;

        var key = toolName.ToLowerInvariant() switch
        {
            "bash" or "shell" => "command",
            "read"            => "file_path",
            "write" or "edit" => "file_path",
            _                 => null,
        };

        if (key == null) return null;
        if (!args.Value.TryGetProperty(key, out var prop)) return null;

        var val = prop.GetString()?.Trim();
        if (string.IsNullOrEmpty(val)) return null;

        return Truncate(val);
    }

    private static string Truncate(string val) =>
        // Truncate long values so the label stays concise in the tray tooltip.
        val.Length > 80 ? val[..77] + "…" : val;

    private static string Capitalize(string s) =>
        s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];
}
