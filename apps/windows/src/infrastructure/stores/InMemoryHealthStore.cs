using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Health;

namespace OpenClawWindows.Infrastructure.Stores;

internal sealed class InMemoryHealthStore : IHealthStore
{
    private readonly Lock _lock = new();
    private HealthSnapshot? _snapshot;
    private DateTimeOffset? _lastSuccess;
    private string? _lastError;
    private bool _isRefreshing;

    public HealthSnapshot? Snapshot       { get { lock (_lock) { return _snapshot; } } }
    public DateTimeOffset? LastSuccess    { get { lock (_lock) { return _lastSuccess; } } }
    public string? LastError              { get { lock (_lock) { return _lastError; } } }
    public bool IsRefreshing              { get { lock (_lock) { return _isRefreshing; } } }

    public event EventHandler? HealthChanged;

    public void Apply(HealthSnapshot snapshot)
    {
        lock (_lock)
        {
            _snapshot    = snapshot;
            _lastSuccess = DateTimeOffset.UtcNow;
            _lastError   = null;
            _isRefreshing = false;
        }
        HealthChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetError(string error)
    {
        lock (_lock)
        {
            _lastError    = error;
            _isRefreshing = false;
        }
        HealthChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetRefreshing(bool refreshing)
    {
        lock (_lock) { _isRefreshing = refreshing; }
        HealthChanged?.Invoke(this, EventArgs.Empty);
    }

    // ── Computed ──────────────────

    public HealthState State
    {
        get
        {
            HealthSnapshot? snap;
            string? err;
            lock (_lock) { snap = _snapshot; err = _lastError; }

            if (!string.IsNullOrEmpty(err))
                return new HealthState.Degraded(err!);
            if (snap is null)
                return new HealthState.Unknown();
            var link = ResolveLinkChannel(snap);
            if (link is null)
                return new HealthState.Unknown();
            if (link.Value.Summary.Linked != true)
            {
                var fallback = ResolveFallbackChannel(snap, link.Value.Id);
                return fallback is not null
                    ? new HealthState.Degraded("Not linked")
                    : new HealthState.LinkingNeeded();
            }
            if (link.Value.Summary.Probe?.Ok == false)
                return new HealthState.Degraded(DescribeProbeFailure(link.Value.Summary.Probe));
            return new HealthState.Ok();
        }
    }

    public string SummaryLine
    {
        get
        {
            HealthSnapshot? snap;
            string? err;
            bool refreshing;
            lock (_lock) { snap = _snapshot; err = _lastError; refreshing = _isRefreshing; }

            if (refreshing)            return "Health check running…";
            if (!string.IsNullOrEmpty(err)) return $"Health check failed: {err}";
            if (snap is null)               return "Health check pending";

            var link = ResolveLinkChannel(snap);
            if (link is null)               return "Health check pending";

            if (link.Value.Summary.Linked != true)
            {
                var fallback = ResolveFallbackChannel(snap, link.Value.Id);
                if (fallback is not null)
                {
                    var fallbackLabel = snap.ChannelLabels?.GetValueOrDefault(fallback.Value.Id)
                                     ?? Capitalize(fallback.Value.Id);
                    var fallbackState = (fallback.Value.Summary.Probe?.Ok ?? true) ? "ok" : "degraded";
                    return $"{fallbackLabel} {fallbackState} · Not linked — run openclaw login";
                }
                return "Not linked — run openclaw login";
            }

            var auth = snap.ChannelLabels is not null
                ? MsToAge(link.Value.Summary.AuthAgeMs ?? 0)
                : (link.Value.Summary.AuthAgeMs.HasValue ? MsToAge(link.Value.Summary.AuthAgeMs.Value) : "unknown");

            if (link.Value.Summary.Probe?.Ok == false)
            {
                var status = link.Value.Summary.Probe.Status?.ToString() ?? "?";
                var suffix = link.Value.Summary.Probe.Status is null
                    ? "probe degraded"
                    : $"probe degraded · status {status}";
                return $"linked · auth {auth} · {suffix}";
            }

            return $"linked · auth {auth}";
        }
    }

    public string? DegradedSummary
    {
        get
        {
            var state = State;
            if (state is not HealthState.Degraded deg) return null;
            var reason = deg.Reason;
            // Strip JS-serialization artifacts that may come from gateway.
            if (reason == "[object Object]" || string.IsNullOrWhiteSpace(reason))
            {
                HealthSnapshot? snap;
                lock (_lock) { snap = _snapshot; }
                if (snap is not null)
                    return DescribeFailure(snap, reason);
            }
            return reason;
        }
    }

    // ── Internal helpers — 1:1 with macOS private methods ───────────────────────────────────

    private static bool IsChannelHealthy(ChannelSummary summary)
    {
        if (summary.Configured != true) return false;
        // Missing probe means "configured but unknown health" — not a hard fail.
        return summary.Probe?.Ok ?? true;
    }

    private static string DescribeProbeFailure(ChannelProbe probe)
    {
        var elapsed = probe.ElapsedMs.HasValue ? $"{(int)probe.ElapsedMs.Value}ms" : null;
        var errLower = probe.Error?.ToLowerInvariant() ?? string.Empty;
        if (errLower.Contains("timeout") || probe.Status is null)
        {
            return elapsed is not null
                ? $"Health check timed out ({elapsed})"
                : "Health check timed out";
        }
        var code = probe.Status.HasValue ? $"status {probe.Status}" : "status unknown";
        var reason = !string.IsNullOrEmpty(probe.Error) ? probe.Error! : "health probe failed";
        return elapsed is not null ? $"{reason} ({code}, {elapsed})" : $"{reason} ({code})";
    }

    private static (string Id, ChannelSummary Summary)? ResolveLinkChannel(HealthSnapshot snap)
    {
        // Prefer linked channels; fall back to any channel with a Linked value set.
        var order = snap.ChannelOrder ?? new List<string>(snap.Channels.Keys);
        foreach (var id in order)
        {
            if (snap.Channels.TryGetValue(id, out var s) && s.Linked == true)
                return (id, s);
        }
        foreach (var id in order)
        {
            if (snap.Channels.TryGetValue(id, out var s) && s.Linked.HasValue)
                return (id, s);
        }
        return null;
    }

    private static (string Id, ChannelSummary Summary)? ResolveFallbackChannel(
        HealthSnapshot snap, string? excludeId)
    {
        var order = snap.ChannelOrder ?? new List<string>(snap.Channels.Keys);
        foreach (var id in order)
        {
            if (id == excludeId) continue;
            if (snap.Channels.TryGetValue(id, out var s) && IsChannelHealthy(s))
                return (id, s);
        }
        return null;
    }

    private string DescribeFailure(HealthSnapshot snap, string? fallback)
    {
        var link = ResolveLinkChannel(snap);
        if (link?.Summary.Linked != true) return "Not linked — run openclaw login";
        if (link?.Summary.Probe?.Ok == false)
            return DescribeProbeFailure(link.Value.Summary.Probe);
        if (!string.IsNullOrEmpty(fallback)) return fallback!;
        return "health probe failed";
    }

    private static string MsToAge(double ms)
    {
        var minutes = (int)Math.Round(ms / 60000.0);
        if (minutes < 1)  return "just now";
        if (minutes < 60) return $"{minutes}m";
        var hours = (int)Math.Round(minutes / 60.0);
        if (hours < 48)   return $"{hours}h";
        var days = (int)Math.Round(hours / 24.0);
        return $"{days}d";
    }

    private static string Capitalize(string s) =>
        s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];
}
