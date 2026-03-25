namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Windows Task Scheduler integration for autostart and cron jobs.
/// Implemented by TaskSchedulerAdapter (Microsoft.Win32.TaskScheduler or Process + schtasks).
/// </summary>
public interface ITaskScheduler
{
    Task RegisterAutostartAsync(string appPath, CancellationToken ct);
    Task UnregisterAutostartAsync(CancellationToken ct);
    Task<bool> IsAutostartRegisteredAsync(CancellationToken ct);
}
