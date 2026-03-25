using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using Windows.ApplicationModel;

namespace OpenClawWindows.Infrastructure.Autostart;

// Windows autostart via StartupTask WinRT API.
// Replaces schtasks.exe process calls with the MSIX-native startup-task mechanism.
// Declared in Package.appxmanifest: desktop:Extension Category="windows.startupTask".
internal sealed class TaskSchedulerAdapter : ITaskScheduler
{
    // Must match the TaskId in Package.appxmanifest desktop:StartupTask declaration.
    private const string TaskId = "OpenClaw";

    private readonly ILogger<TaskSchedulerAdapter> _logger;

    public TaskSchedulerAdapter(ILogger<TaskSchedulerAdapter> logger)
    {
        _logger = logger;
    }

    // appPath is ignored — the exe is declared in the manifest, not passed at runtime.
    public async Task RegisterAutostartAsync(string appPath, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!IsPackaged()) { _logger.LogWarning("Autostart skipped — app is not MSIX-packaged"); return; }

        var task = await StartupTask.GetAsync(TaskId);
        if (task.State is StartupTaskState.Disabled)
        {
            // Shows the system consent dialog if required; returns the resulting state.
            var newState = await task.RequestEnableAsync();
            _logger.LogInformation("Autostart enable request result: {State}", newState);
        }
        else
        {
            _logger.LogInformation("Autostart already in state {State}", task.State);
        }
    }

    public async Task UnregisterAutostartAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!IsPackaged()) { _logger.LogWarning("Autostart skipped — app is not MSIX-packaged"); return; }

        var task = await StartupTask.GetAsync(TaskId);
        task.Disable();
        _logger.LogInformation("Autostart disabled");
    }

    public async Task<bool> IsAutostartRegisteredAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!IsPackaged()) return false;

        var task = await StartupTask.GetAsync(TaskId);
        return task.State is StartupTaskState.Enabled or StartupTaskState.EnabledByPolicy;
    }

    // StartupTask requires MSIX package identity — not available in dev unpackaged builds.
    private static bool IsPackaged()
    {
        try { _ = Package.Current; return true; }
        catch (InvalidOperationException) { return false; }
    }
}
