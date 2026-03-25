namespace OpenClawWindows.Infrastructure.Fs;

internal sealed class SimpleFileWatcher : IDisposable
{
    private readonly CoalescingFileSystemWatcher _watcher;

    internal SimpleFileWatcher(CoalescingFileSystemWatcher watcher)
    {
        _watcher = watcher;
    }

    internal void Start() => _watcher.Start();
    internal void Stop() => _watcher.Stop();

    public void Dispose() => Stop();
}
