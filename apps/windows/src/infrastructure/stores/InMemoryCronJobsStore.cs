using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;

namespace OpenClawWindows.Infrastructure.Stores;

// Thread-safe state holder for cron jobs and scheduler status.
// CronJobsPollingHostedService drives RPC calls and feeds results in via Apply*().
internal sealed class InMemoryCronJobsStore : ICronJobsStore
{
    private readonly object _lock = new();

    private IReadOnlyList<GatewayCronJob> _jobs = [];
    private string? _selectedJobId;
    private IReadOnlyList<GatewayCronRunLogEntry> _runEntries = [];

    private bool? _schedulerEnabled;
    private string? _schedulerStorePath;
    private long? _schedulerNextWakeAtMs;

    private bool _isLoadingJobs;
    private bool _isLoadingRuns;
    private string? _lastError;
    private string? _statusMessage;

    // Refresh signals set by HandleCronEvent — consumed by the polling service.
    private bool _refreshPending;
    private bool _runsPending;
    private string? _runsPendingJobId;

    public IReadOnlyList<GatewayCronJob> Jobs { get { lock (_lock) return _jobs; } }

    public string? SelectedJobId
    {
        get { lock (_lock) return _selectedJobId; }
        set { lock (_lock) { _selectedJobId = value; } }
    }

    public IReadOnlyList<GatewayCronRunLogEntry> RunEntries { get { lock (_lock) return _runEntries; } }

    public bool? SchedulerEnabled { get { lock (_lock) return _schedulerEnabled; } }
    public string? SchedulerStorePath { get { lock (_lock) return _schedulerStorePath; } }
    public long? SchedulerNextWakeAtMs { get { lock (_lock) return _schedulerNextWakeAtMs; } }

    public bool IsLoadingJobs { get { lock (_lock) return _isLoadingJobs; } }
    public bool IsLoadingRuns { get { lock (_lock) return _isLoadingRuns; } }
    public string? LastError { get { lock (_lock) return _lastError; } }
    public string? StatusMessage { get { lock (_lock) return _statusMessage; } }

    public event EventHandler? StateChanged;

    public void ApplyJobsSnapshot(IReadOnlyList<GatewayCronJob> jobs, GatewayCronSchedulerStatus? status)
    {
        lock (_lock)
        {
            _jobs = jobs;
            _lastError = null;
            _statusMessage = jobs.Count == 0 ? "No cron jobs yet." : null;

            if (status is not null)
            {
                _schedulerEnabled = status.Enabled;
                _schedulerStorePath = status.StorePath;
                _schedulerNextWakeAtMs = status.NextWakeAtMs;
            }
        }

        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    public void ApplyRunsSnapshot(IReadOnlyList<GatewayCronRunLogEntry> entries)
    {
        lock (_lock) { _runEntries = entries; }
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetJobsLoading(bool loading)
    {
        lock (_lock) { _isLoadingJobs = loading; }
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetRunsLoading(bool loading)
    {
        lock (_lock) { _isLoadingRuns = loading; }
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetError(string error)
    {
        lock (_lock) { _lastError = error; }
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    public void HandleCronEvent(string jobId, string action)
    {
        lock (_lock)
        {
            // Mirror scheduleRefresh(delayMs: 250) — polling service will see the flag and poll.
            _refreshPending = true;

            // Mirror scheduleRunsRefresh — only when the finished job is the currently selected one.
            if (string.Equals(action, "finished", StringComparison.OrdinalIgnoreCase)
                && _selectedJobId is not null
                && string.Equals(_selectedJobId, jobId, StringComparison.OrdinalIgnoreCase))
            {
                _runsPending = true;
                _runsPendingJobId = jobId;
            }
        }
    }

    public void SignalRefresh()
    {
        lock (_lock) { _refreshPending = true; }
    }

    public bool ConsumeRefreshSignal()
    {
        lock (_lock)
        {
            if (!_refreshPending) return false;
            _refreshPending = false;
            return true;
        }
    }

    public (bool Pending, string? JobId) ConsumeRunsRefreshSignal()
    {
        lock (_lock)
        {
            if (!_runsPending) return (false, null);
            _runsPending = false;
            var jobId = _runsPendingJobId;
            _runsPendingJobId = null;
            return (true, jobId);
        }
    }
}
