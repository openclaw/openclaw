using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.Audio;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Audio;

public sealed class MicLevelMonitorTests
{
    // ── NormalizedLevel (static algorithm) ───────────────────────────────────

    [Fact]
    public void NormalizedLevel_EmptyBuffer_ReturnsZero()
    {
        // Swift: guard frameCount > 0 else { return 0 }
        var level = MicLevelMonitor.NormalizedLevel([]);
        Assert.Equal(0.0, level);
    }

    [Fact]
    public void NormalizedLevel_SilenceBuffer_ReturnsZero()
    {
        // All-zero PCM → RMS ≈ 1e-6 → db ≈ −120 → (−120 + 50) / 50 = −1.4 → max(0) = 0
        var buffer = new byte[64];
        var level = MicLevelMonitor.NormalizedLevel(buffer);
        Assert.Equal(0.0, level);
    }

    [Fact]
    public void NormalizedLevel_MaxAmplitudeBuffer_ReturnsOne()
    {
        // Int16.MaxValue (32767) / 32768 ≈ 1.0 → RMS ≈ 1 → db ≈ 0 → (0 + 50) / 50 = 1
        var buffer = new byte[4];
        BitConverter.TryWriteBytes(buffer.AsSpan(0, 2), short.MaxValue);
        BitConverter.TryWriteBytes(buffer.AsSpan(2, 2), short.MaxValue);
        var level = MicLevelMonitor.NormalizedLevel(buffer);
        Assert.Equal(1.0, level, precision: 4);
    }

    [Fact]
    public void NormalizedLevel_PartialBuffer_OddBytesIgnored()
    {
        // 3 bytes → frameCount = 1 (the extra byte is ignored — same as Swift's Int(buffer.frameLength))
        var buffer = new byte[] { 0xFF, 0x7F, 0xAB };
        var level = MicLevelMonitor.NormalizedLevel(buffer);
        Assert.InRange(level, 0.0, 1.0);
    }

    [Fact]
    public void NormalizedLevel_Result_ClampedToUnitInterval()
    {
        // Verify no result ever exceeds [0, 1] for arbitrary PCM data
        var rng = new global::System.Random(42);
        for (int trial = 0; trial < 50; trial++)
        {
            var buffer = new byte[128];
            rng.NextBytes(buffer);
            var level = MicLevelMonitor.NormalizedLevel(buffer);
            Assert.InRange(level, 0.0, 1.0);
        }
    }

    // ── StartAsync — no device ────────────────────────────────────────────────

    [Fact]
    public async Task StartAsync_NoUsableDevice_ThrowsInvalidOperationException()
    {
        // Swift: guard AudioInputDeviceObserver.hasUsableDefaultInputDevice() else { throw error }
        var capture = Substitute.For<IAudioCaptureDevice>();
        capture.HasUsableDefaultDevice().Returns(false);
        using var monitor = new MicLevelMonitor(NullLogger<MicLevelMonitor>.Instance, capture);

        await Assert.ThrowsAsync<InvalidOperationException>(() => monitor.StartAsync());
    }

    // ── StartAsync — idempotent ───────────────────────────────────────────────

    [Fact]
    public async Task StartAsync_AlreadyRunning_StartsOnlyOnce()
    {
        // Swift: if self.running { return }
        var capture = Substitute.For<IAudioCaptureDevice>();
        capture.HasUsableDefaultDevice().Returns(true);

        // Never complete capture — keeps _running = true until Stop
        var captureGate = new TaskCompletionSource();
        capture.StartCaptureAsync(
                Arg.Any<int>(), Arg.Any<int>(),
                Arg.Any<Func<byte[], Task>>(), Arg.Any<CancellationToken>())
            .Returns(captureGate.Task);

        using var monitor = new MicLevelMonitor(NullLogger<MicLevelMonitor>.Instance, capture);
        await monitor.StartAsync();
        await monitor.StartAsync(); // second call — should be no-op

        await capture.Received(1).StartCaptureAsync(
            Arg.Any<int>(), Arg.Any<int>(),
            Arg.Any<Func<byte[], Task>>(), Arg.Any<CancellationToken>());

        captureGate.TrySetCanceled();
        await monitor.StopAsync();
    }

    // ── StopAsync — idempotent ────────────────────────────────────────────────

    [Fact]
    public async Task StopAsync_WhenNotRunning_DoesNotThrow()
    {
        // Swift: guard self.running else { return }
        var capture = Substitute.For<IAudioCaptureDevice>();
        using var monitor = new MicLevelMonitor(NullLogger<MicLevelMonitor>.Instance, capture);

        await monitor.StopAsync(); // should not throw
    }

    // ── Observer — notifications ──────────────────────────────────────────────

    [Fact]
    public async Task Subscribe_ReceivesLevelNotifications()
    {
        // When a buffer is delivered, the observer should receive the smoothed level.
        var capture = Substitute.For<IAudioCaptureDevice>();
        capture.HasUsableDefaultDevice().Returns(true);

        Func<byte[], Task>? capturedCallback = null;
        var captureStarted = new TaskCompletionSource();

        capture.StartCaptureAsync(
                Arg.Any<int>(), Arg.Any<int>(),
                Arg.Any<Func<byte[], Task>>(), Arg.Any<CancellationToken>())
            .Returns(ci =>
            {
                capturedCallback = ci.ArgAt<Func<byte[], Task>>(2);
                captureStarted.TrySetResult();
                return Task.Delay(Timeout.Infinite, ci.ArgAt<CancellationToken>(3));
            });

        using var monitor = new MicLevelMonitor(NullLogger<MicLevelMonitor>.Instance, capture);

        var received = new List<double>();
        var observer = Substitute.For<IObserver<double>>();
        observer.When(o => o.OnNext(Arg.Any<double>()))
                .Do(ci => received.Add(ci.ArgAt<double>(0)));

        using var sub = monitor.Subscribe(observer);
        await monitor.StartAsync();
        await captureStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        // Send max-amplitude buffer — level should be 1.0, smoothed to 0.55 on first call
        var maxBuffer = new byte[4];
        BitConverter.TryWriteBytes(maxBuffer.AsSpan(0, 2), short.MaxValue);
        BitConverter.TryWriteBytes(maxBuffer.AsSpan(2, 2), short.MaxValue);
        await capturedCallback!(maxBuffer);

        Assert.Single(received);
        Assert.InRange(received[0], 0.0, 1.0);

        await monitor.StopAsync();
    }

    [Fact]
    public async Task Subscribe_AfterDispose_StopsReceivingNotifications()
    {
        // Unsubscribing removes the observer from the notification set.
        var capture = Substitute.For<IAudioCaptureDevice>();
        capture.HasUsableDefaultDevice().Returns(true);

        Func<byte[], Task>? capturedCallback = null;
        var captureStarted = new TaskCompletionSource();

        capture.StartCaptureAsync(
                Arg.Any<int>(), Arg.Any<int>(),
                Arg.Any<Func<byte[], Task>>(), Arg.Any<CancellationToken>())
            .Returns(ci =>
            {
                capturedCallback = ci.ArgAt<Func<byte[], Task>>(2);
                captureStarted.TrySetResult();
                return Task.Delay(Timeout.Infinite, ci.ArgAt<CancellationToken>(3));
            });

        using var monitor = new MicLevelMonitor(NullLogger<MicLevelMonitor>.Instance, capture);

        var callCount = 0;
        var observer = Substitute.For<IObserver<double>>();
        observer.When(o => o.OnNext(Arg.Any<double>())).Do(_ => callCount++);

        var sub = monitor.Subscribe(observer);
        await monitor.StartAsync();
        await captureStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var buf = new byte[4];
        BitConverter.TryWriteBytes(buf.AsSpan(0, 2), short.MaxValue);
        BitConverter.TryWriteBytes(buf.AsSpan(2, 2), short.MaxValue);

        await capturedCallback!(buf);
        Assert.Equal(1, callCount);

        sub.Dispose(); // unsubscribe
        await capturedCallback!(buf);
        Assert.Equal(1, callCount); // no new notifications after dispose

        await monitor.StopAsync();
    }
}
