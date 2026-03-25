namespace OpenClawWindows.Infrastructure.Fs;

/// <summary>
/// Mixin that provides Start/Stop lifecycle methods to any class that owns a SimpleFileWatcher.
/// </summary>
internal interface ISimpleFileWatcherOwner
{
    SimpleFileWatcher Watcher { get; }

    // Default implementations mirror the Swift protocol extension.
    void Start() => Watcher.Start();
    void Stop() => Watcher.Stop();
}
