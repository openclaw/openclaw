namespace OpenClawWindows.Infrastructure.Fs;

internal sealed class CanvasFileWatcher : ISimpleFileWatcherOwner, IDisposable
{
    public SimpleFileWatcher Watcher { get; }

    // Wraps CoalescingFileSystemWatcher and starts it immediately.
    internal CanvasFileWatcher(string path, Action onChange)
    {
        Watcher = new SimpleFileWatcher(
            new CoalescingFileSystemWatcher([path], onChange));
        Watcher.Start();
    }

    public void Dispose() => Watcher.Dispose();
}
