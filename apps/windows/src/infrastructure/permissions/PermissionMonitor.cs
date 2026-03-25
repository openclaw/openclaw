using OpenClawWindows.Domain.Permissions;

namespace OpenClawWindows.Infrastructure.Permissions;

// Polls permission status every 1 second when at least one consumer is registered.
// Ref-counting via Register()/Unregister() starts/stops the polling timer.
internal sealed class PermissionMonitor : IDisposable
{
    // Matches PermissionMonitor.minimumCheckInterval (0.5s) and timer interval (1.0s).
    private const int PollIntervalMs        = 1000;
    private const int MinimumCheckIntervalMs = 500;

    public static PermissionMonitor Shared { get; } = new();

    public event EventHandler<IReadOnlyDictionary<Capability, bool>>? StatusChanged;

    private IReadOnlyDictionary<Capability, bool> _status = new Dictionary<Capability, bool>();
    public IReadOnlyDictionary<Capability, bool> Status => _status;

    private readonly IPermissionManager? _manager;
    private readonly object _lock = new();
    private int _registrations;
    private Timer? _timer;
    private DateTimeOffset _lastCheck = DateTimeOffset.MinValue;
    private bool _isChecking;

    // Default ctor for singleton — manager injected lazily via SetManager().
    private PermissionMonitor() { }

    internal PermissionMonitor(IPermissionManager manager)
    {
        _manager = manager;
    }

    // Called by DI to wire the real IPermissionManager into the singleton.
    private IPermissionManager? _injectedManager;

    internal void SetManager(IPermissionManager manager)
    {
        _injectedManager = manager;
    }

    private IPermissionManager? ActiveManager => _injectedManager ?? _manager;

    // ── Registration (ref-counting) ──────────────────────────────────────────

    public void Register()
    {
        lock (_lock)
        {
            _registrations++;
            if (_registrations == 1)
                StartMonitoring();
        }
    }

    public void Unregister()
    {
        lock (_lock)
        {
            if (_registrations == 0) return;
            _registrations--;
            if (_registrations == 0)
                StopMonitoring();
        }
    }

    public Task RefreshNowAsync() => CheckStatusAsync(force: true);

    // ── private ──────────────────────────────────────────────────────────────

    private void StartMonitoring()
    {
        _ = CheckStatusAsync(force: true);
        _timer = new Timer(_ => _ = CheckStatusAsync(force: false), null, PollIntervalMs, PollIntervalMs);
    }

    private void StopMonitoring()
    {
        _timer?.Dispose();
        _timer = null;
        _lastCheck = DateTimeOffset.MinValue;
    }

    private async Task CheckStatusAsync(bool force)
    {
        if (ActiveManager is null) return;

        lock (_lock)
        {
            if (_isChecking) return;
            var now = DateTimeOffset.UtcNow;
            if (!force && (now - _lastCheck).TotalMilliseconds < MinimumCheckIntervalMs) return;
            _isChecking = true;
        }

        try
        {
            var latest = await ActiveManager.StatusAsync();
            lock (_lock)
            {
                _lastCheck = DateTimeOffset.UtcNow;
                _isChecking = false;
                if (!StatusEqual(_status, latest))
                {
                    _status = latest;
                    StatusChanged?.Invoke(this, latest);
                }
            }
        }
        catch
        {
            lock (_lock) { _isChecking = false; }
        }
    }

    private static bool StatusEqual(
        IReadOnlyDictionary<Capability, bool> a,
        IReadOnlyDictionary<Capability, bool> b)
    {
        if (a.Count != b.Count) return false;
        foreach (var kv in a)
            if (!b.TryGetValue(kv.Key, out var val) || val != kv.Value) return false;
        return true;
    }

    public void Dispose()
    {
        lock (_lock)
            StopMonitoring();
    }
}
