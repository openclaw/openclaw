namespace OpenClawWindows.Infrastructure.Fs;

/// <summary>
/// Wraps System.IO.FileSystemWatcher with debounce to suppress duplicate events during rapid
/// file-system bursts (builds, atomic saves).
/// </summary>
internal sealed class CoalescingFileSystemWatcher : IDisposable
{
    private readonly IReadOnlyList<string> _paths;
    private readonly TimeSpan _coalesceDelay;
    private readonly Func<int, bool>? _shouldNotify;
    private readonly Action _onChange;

    private readonly List<FileSystemWatcher> _watchers = [];
    private int _pending; // 0/1; access via Interlocked

    // Tunables
    internal static readonly TimeSpan DefaultCoalesceDelay =
        TimeSpan.FromMilliseconds(120); // 120 ms coalesce delay

    // Internal for testing — reports how many FileSystemWatcher instances are active.
    internal int WatcherCount => _watchers.Count;

    internal CoalescingFileSystemWatcher(
        IReadOnlyList<string> paths,
        Action onChange,
        TimeSpan coalesceDelay = default,
        Func<int, bool>? shouldNotify = null)
    {
        _paths = paths;
        _onChange = onChange;
        _coalesceDelay = coalesceDelay == default ? DefaultCoalesceDelay : coalesceDelay;
        _shouldNotify = shouldNotify;
    }

    internal void Start()
    {
        if (_watchers.Count > 0) return;
        foreach (var path in _paths)
            Install(path);
    }

    internal void Stop()
    {
        foreach (var w in _watchers) w.Dispose();
        _watchers.Clear();
        Interlocked.Exchange(ref _pending, 0);
    }

    private void Install(string path)
    {
        var w = new FileSystemWatcher(path)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite,
            EnableRaisingEvents = true,
        };
        w.Changed += OnEvent;
        w.Created += OnEvent;
        w.Deleted += OnEvent;
        w.Renamed += OnRenamed;
        _watchers.Add(w);
    }

    private void OnEvent(object _, FileSystemEventArgs __) => HandleEvent(1);
    private void OnRenamed(object _, RenamedEventArgs __) => HandleEvent(1);

    internal void HandleEvent(int numEvents)
    {
        if (_shouldNotify != null && !_shouldNotify(numEvents)) return;

        // Coalesce rapid changes (common during builds/atomic saves).
        if (Interlocked.CompareExchange(ref _pending, 1, 0) != 0) return;

        _ = Task.Delay(_coalesceDelay).ContinueWith(_ =>
        {
            Interlocked.Exchange(ref _pending, 0);
            _onChange();
        }, TaskScheduler.Default);
    }

    public void Dispose() => Stop();
}
