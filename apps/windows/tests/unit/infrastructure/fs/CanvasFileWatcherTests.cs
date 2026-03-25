using OpenClawWindows.Infrastructure.Fs;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Fs;

public sealed class CanvasFileWatcherTests : IDisposable
{
    private readonly string _dir;

    public CanvasFileWatcherTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "ocw_canvas_fw_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ }
    }

    // mirrors Swift: testDetectsInPlaceFileWrites
    [Fact]
    public async Task Constructor_AutoStarts_OnChangeFiresOnFileCreation()
    {
        var tcs = new TaskCompletionSource();
        using var watcher = new CanvasFileWatcher(_dir, () => tcs.TrySetResult());

        await File.WriteAllTextAsync(Path.Combine(_dir, "test.txt"), "initial");

        var fired = await Task.WhenAny(tcs.Task, Task.Delay(TimeSpan.FromSeconds(2))) == tcs.Task;
        fired.Should().BeTrue("onChange should fire within 2 seconds of a file creation");
    }

    [Fact]
    public void Implements_ISimpleFileWatcherOwner_WithNonNullWatcher()
    {
        using var watcher = new CanvasFileWatcher(_dir, () => { });
        ((ISimpleFileWatcherOwner)watcher).Watcher.Should().NotBeNull();
    }

    [Fact]
    public void Dispose_DoesNotThrow()
    {
        var watcher = new CanvasFileWatcher(_dir, () => { });
        var act = () => watcher.Dispose();
        act.Should().NotThrow();
    }
}
