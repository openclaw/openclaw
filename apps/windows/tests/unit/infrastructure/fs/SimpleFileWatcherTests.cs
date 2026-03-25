using OpenClawWindows.Infrastructure.Fs;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Fs;

public sealed class SimpleFileWatcherTests
{
    private static readonly string TempDir = Path.GetTempPath();

    private static (SimpleFileWatcher watcher, CoalescingFileSystemWatcher inner) Make()
    {
        var inner = new CoalescingFileSystemWatcher([TempDir], () => { });
        return (new SimpleFileWatcher(inner), inner);
    }

    [Fact]
    public void Start_DelegatesToInner()
    {
        var (watcher, inner) = Make();
        try
        {
            watcher.Start();
            inner.WatcherCount.Should().Be(1);
        }
        finally
        {
            watcher.Dispose();
        }
    }

    [Fact]
    public void Stop_DelegatesToInner()
    {
        var (watcher, inner) = Make();
        watcher.Start();
        watcher.Stop();
        inner.WatcherCount.Should().Be(0);
    }

    [Fact]
    public void Dispose_CallsStop()
    {
        var (watcher, inner) = Make();
        watcher.Start();
        watcher.Dispose();
        inner.WatcherCount.Should().Be(0);
    }

    [Fact]
    public void ISimpleFileWatcherOwner_DefaultStart_DelegatesToWatcher()
    {
        var inner = new CoalescingFileSystemWatcher([TempDir], () => { });
        var sw = new SimpleFileWatcher(inner);
        // Owner whose Watcher property is the SimpleFileWatcher under test.
        var owner = new TestOwner(sw);

        // Default interface methods require explicit cast to the interface.
        ((ISimpleFileWatcherOwner)owner).Start();
        inner.WatcherCount.Should().Be(1);

        ((ISimpleFileWatcherOwner)owner).Stop();
        inner.WatcherCount.Should().Be(0);
        sw.Dispose();
    }

    private sealed class TestOwner : ISimpleFileWatcherOwner
    {
        public SimpleFileWatcher Watcher { get; }
        public TestOwner(SimpleFileWatcher w) => Watcher = w;
    }
}
