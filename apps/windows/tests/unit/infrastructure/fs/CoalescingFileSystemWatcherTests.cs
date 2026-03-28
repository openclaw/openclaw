using OpenClawWindows.Infrastructure.Fs;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Fs;

public sealed class CoalescingFileSystemWatcherTests : IDisposable
{
    // Use the system temp dir — always exists, no cleanup needed.
    private static readonly string TempDir = Path.GetTempPath();

    private CoalescingFileSystemWatcher Make(
        string[]? paths = null,
        Action? onChange = null,
        TimeSpan coalesceDelay = default,
        Func<int, bool>? shouldNotify = null)
        => new(
            paths ?? [TempDir],
            onChange ?? (() => { }),
            coalesceDelay,
            shouldNotify);

    // Track watchers created during the test for cleanup.
    private readonly List<CoalescingFileSystemWatcher> _created = [];

    private CoalescingFileSystemWatcher Track(CoalescingFileSystemWatcher w)
    {
        _created.Add(w);
        return w;
    }

    public void Dispose()
    {
        foreach (var w in _created) w.Dispose();
    }

    [Fact]
    public void Start_CreatesOneWatcherPerPath()
    {
        var w = Track(Make(paths: [TempDir, TempDir]));
        w.Start();
        w.WatcherCount.Should().Be(2);
    }

    [Fact]
    public void Start_Idempotent_DoesNotAddWatchers()
    {
        var w = Track(Make());
        w.Start();
        w.Start();
        w.WatcherCount.Should().Be(1);
    }

    [Fact]
    public void Stop_ClearsWatchers()
    {
        var w = Track(Make());
        w.Start();
        w.Stop();
        w.WatcherCount.Should().Be(0);
    }

    [Fact]
    public void Stop_AllowsRestart()
    {
        var w = Track(Make());
        w.Start();
        w.Stop();
        w.Start();
        w.WatcherCount.Should().Be(1);
    }

    [Fact]
    public void DefaultCoalesceDelay_Is120Ms()
        => CoalescingFileSystemWatcher.DefaultCoalesceDelay
            .Should().Be(TimeSpan.FromMilliseconds(120));

    [Fact]
    public async Task HandleEvents_Coalescing_FiresOnlyOnce()
    {
        var callCount = 0;
        var shortDelay = TimeSpan.FromMilliseconds(50);
        // No Start() — HandleEvent is called directly so no FS watcher is needed.
        // Starting would install a real FileSystemWatcher on TempDir and parallel tests
        // writing there could fire spurious callbacks after the coalesce window closes.
        var w = Track(Make(onChange: () => Interlocked.Increment(ref callCount), coalesceDelay: shortDelay));

        // Two rapid events via HandleEvent (deterministic) — second should be coalesced.
        w.HandleEvent(1);
        w.HandleEvent(1);

        // Wait long enough for the coalesce window to close.
        // 10x buffer: Task.Delay under heavy parallel test load can fire late.
        await Task.Delay(shortDelay * 10);

        callCount.Should().Be(1);
    }

    [Fact]
    public void ShouldNotify_False_SuppressesCallback()
    {
        var called = false;
        // shouldNotify always returns false — onChange must never fire.
        var w = Track(Make(onChange: () => called = true, shouldNotify: _ => false));
        w.Start();

        // Call HandleEvent directly (internal) to simulate an event without touching the FS.
        w.HandleEvent(1);

        called.Should().BeFalse();
    }
}
