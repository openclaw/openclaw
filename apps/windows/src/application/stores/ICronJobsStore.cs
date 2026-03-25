using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// In-memory cache of cron jobs and scheduler status, kept in sync with the gateway.
/// </summary>
public interface ICronJobsStore
{
    IReadOnlyList<GatewayCronJob> Jobs { get; }
    string? SelectedJobId { get; set; }
    IReadOnlyList<GatewayCronRunLogEntry> RunEntries { get; }

    bool? SchedulerEnabled { get; }
    string? SchedulerStorePath { get; }
    long? SchedulerNextWakeAtMs { get; }

    bool IsLoadingJobs { get; }
    bool IsLoadingRuns { get; }
    string? LastError { get; }
    string? StatusMessage { get; }

    event EventHandler? StateChanged;

    // Called by the polling service after each successful fetch.
    void ApplyJobsSnapshot(IReadOnlyList<GatewayCronJob> jobs, GatewayCronSchedulerStatus? status);
    void ApplyRunsSnapshot(IReadOnlyList<GatewayCronRunLogEntry> entries);
    void SetJobsLoading(bool loading);
    void SetRunsLoading(bool loading);
    void SetError(string error);

    // Called by RouteEvent on "cron" gateway push
    void HandleCronEvent(string jobId, string action);

    // Called on gateway reconnect to force an immediate jobs poll.
    void SignalRefresh();

    // Polling service calls these to detect event-triggered refresh requests.
    bool ConsumeRefreshSignal();
    (bool Pending, string? JobId) ConsumeRunsRefreshSignal();
}
