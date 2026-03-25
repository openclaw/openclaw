using MediatR;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Settings;

namespace OpenClawWindows.Infrastructure.Settings;

// Watches settings.json for external changes and dispatches HandleSettingsHotReloadCommand.
// from SaveAsync produces two events) before dispatching.
internal sealed class SettingsFileWatcher : IHostedService, IDisposable
{
    // Default coalesceDelay: 0.12 s
    private const int CoalesceMs = 120;

    private readonly string _settingsPath;
    private readonly IMediator _mediator;
    private readonly ILogger<SettingsFileWatcher> _logger;
    private FileSystemWatcher? _watcher;
    private Timer? _coalesceTimer;
    private readonly object _timerLock = new();

    public SettingsFileWatcher(IMediator mediator, ILogger<SettingsFileWatcher> logger)
    {
        _mediator = mediator;
        _logger = logger;
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        _settingsPath = Path.Combine(appData, "OpenClaw", "settings.json");
    }

    public Task StartAsync(CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(_settingsPath)!;
        Directory.CreateDirectory(dir);

        _watcher = new FileSystemWatcher(dir, Path.GetFileName(_settingsPath))
        {
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName,
            EnableRaisingEvents = true,
        };

        _watcher.Changed += OnFileEvent;
        _watcher.Created += OnFileEvent;
        _watcher.Renamed += OnRenamedEvent;

        _logger.LogInformation("Watching {Path} for external changes", _settingsPath);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        _watcher?.Dispose();
        _watcher = null;
        return Task.CompletedTask;
    }

    private void OnFileEvent(object sender, FileSystemEventArgs e) => ScheduleDispatch(e.FullPath);

    // Renamed fires when SaveAsync's write-then-rename completes — treat as a change.
    private void OnRenamedEvent(object sender, RenamedEventArgs e) => ScheduleDispatch(e.FullPath);

    // Coalesce rapid events before dispatching, matching .
    private void ScheduleDispatch(string path)
    {
        lock (_timerLock)
        {
            _coalesceTimer?.Dispose();
            _coalesceTimer = new Timer(_ => Dispatch(path), null, CoalesceMs, Timeout.Infinite);
        }
    }

    private void Dispatch(string path)
    {
        _ = _mediator.Send(new HandleSettingsHotReloadCommand(path));
    }

    public void Dispose()
    {
        _watcher?.Dispose();
        lock (_timerLock)
            _coalesceTimer?.Dispose();
    }
}
