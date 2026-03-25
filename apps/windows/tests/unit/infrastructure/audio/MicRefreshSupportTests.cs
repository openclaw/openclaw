using NSubstitute;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.Audio;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Audio;

public sealed class MicRefreshSupportTests
{
    // ── SelectedMicName ───────────────────────────────────────────────────────

    [Fact]
    public void SelectedMicName_EmptyId_ReturnsEmpty()
    {
        // Swift: guard !selectedID.isEmpty else { return "" }
        var result = MicRefreshSupport.SelectedMicName(
            "", [("uid-1", "Mic A")], d => d.Item1, d => d.Item2);
        Assert.Equal("", result);
    }

    [Fact]
    public void SelectedMicName_MatchingUid_ReturnsName()
    {
        // Swift: devices.first(where: { $0[keyPath: uid] == selectedID })?[keyPath: name]
        var devices = new[] { ("uid-1", "Mic A"), ("uid-2", "Mic B") };
        var result = MicRefreshSupport.SelectedMicName(
            "uid-2", devices, d => d.Item1, d => d.Item2);
        Assert.Equal("Mic B", result);
    }

    [Fact]
    public void SelectedMicName_NoMatchingUid_ReturnsEmpty()
    {
        // Swift: ?? "" fallback when first(where:) returns nil
        var devices = new[] { ("uid-1", "Mic A") };
        var result = MicRefreshSupport.SelectedMicName(
            "uid-99", devices, d => d.Item1, d => d.Item2);
        Assert.Equal("", result);
    }

    [Fact]
    public void SelectedMicName_EmptyDeviceList_ReturnsEmpty()
    {
        var result = MicRefreshSupport.SelectedMicName<(string, string)>(
            "uid-1", [], d => d.Item1, d => d.Item2);
        Assert.Equal("", result);
    }

    // ── StartObserver ─────────────────────────────────────────────────────────

    [Fact]
    public void StartObserver_DefaultDeviceChanged_CallsTriggerRefresh()
    {
        // Swift: observer.start { Task { @MainActor in triggerRefresh() } }
        // In test host, DispatcherQueue is unavailable so triggerRefresh is called directly.
        var device  = Substitute.For<IAudioCaptureDevice>();
        var callCount = 0;

        MicRefreshSupport.StartObserver(device, () => callCount++);
        device.DefaultDeviceChanged += Raise.Event();

        Assert.Equal(1, callCount);
    }

    [Fact]
    public void StartObserver_MultipleChanges_TriggersEachTime()
    {
        var device    = Substitute.For<IAudioCaptureDevice>();
        var callCount = 0;

        MicRefreshSupport.StartObserver(device, () => callCount++);
        device.DefaultDeviceChanged += Raise.Event();
        device.DefaultDeviceChanged += Raise.Event();
        device.DefaultDeviceChanged += Raise.Event();

        Assert.Equal(3, callCount);
    }

    // ── Schedule ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task Schedule_ExecutesActionAfterDelay()
    {
        // Swift: Task.sleep(nanoseconds: 300_000_000); await action()
        var executed = new TaskCompletionSource<bool>();
        CancellationTokenSource? cts = null;

        MicRefreshSupport.Schedule(ref cts, () =>
        {
            executed.TrySetResult(true);
            return Task.CompletedTask;
        });

        var result = await executed.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.True(result);
        cts?.Dispose();
    }

    [Fact]
    public async Task Schedule_Debounce_CancelsPreviousAndRunsOnlyLast()
    {
        // Swift: refreshTask?.cancel(); refreshTask = Task { sleep; action() }
        // Two rapid calls — only the second action should fire.
        var callCount = 0;
        CancellationTokenSource? cts = null;

        MicRefreshSupport.Schedule(ref cts, () =>
        {
            callCount++;
            return Task.CompletedTask;
        });

        // Immediately schedule again — cancels the first
        MicRefreshSupport.Schedule(ref cts, () =>
        {
            callCount++;
            return Task.CompletedTask;
        });

        // Wait long enough for the second action to fire
        await Task.Delay(MicRefreshSupport.RefreshDelay + TimeSpan.FromMilliseconds(100));
        Assert.Equal(1, callCount);
        cts?.Dispose();
    }

    [Fact]
    public async Task Schedule_CancelledExternally_ActionDoesNotRun()
    {
        // Swift: guard !Task.isCancelled else { return }
        var callCount = 0;
        CancellationTokenSource? cts = null;

        MicRefreshSupport.Schedule(ref cts, () =>
        {
            callCount++;
            return Task.CompletedTask;
        });

        // Cancel immediately before the delay elapses
        cts!.Cancel();

        await Task.Delay(MicRefreshSupport.RefreshDelay + TimeSpan.FromMilliseconds(100));
        Assert.Equal(0, callCount);
        cts.Dispose();
    }
}
