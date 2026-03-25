namespace OpenClawWindows.Tests.Unit.Domain.SharedKernel;

/// <summary>
/// Verifies rate limits exactly match CaptureRateLimits.swift — 1:1 parity requirement.
/// </summary>
public sealed class RateLimitTests
{
    // Canonical values from CONTEXTO_WINDOWS.md — MUST NOT change without macOS parity check.

    [Fact]
    public void ScreenRecord_MinDuration_Is250ms() =>
        RateLimit.ScreenRecordMinDurationMs.Should().Be(250);

    [Fact]
    public void ScreenRecord_MaxDuration_Is60s() =>
        RateLimit.ScreenRecordMaxDurationMs.Should().Be(60_000);

    [Fact]
    public void ScreenRecord_DefaultDuration_Is10s() =>
        RateLimit.ScreenRecordDefaultDurationMs.Should().Be(10_000);

    [Fact]
    public void ScreenRecord_MinFps_Is1() =>
        RateLimit.ScreenRecordMinFps.Should().Be(1);

    [Fact]
    public void ScreenRecord_MaxFps_Is60() =>
        RateLimit.ScreenRecordMaxFps.Should().Be(60);

    [Fact]
    public void ScreenRecord_DefaultFps_Is10() =>
        RateLimit.ScreenRecordDefaultFps.Should().Be(10);

    [Fact]
    public void CameraClip_MinDuration_Is250ms() =>
        RateLimit.CameraClipMinDurationMs.Should().Be(250);

    [Fact]
    public void CameraClip_MaxDuration_Is60s() =>
        RateLimit.CameraClipMaxDurationMs.Should().Be(60_000);

    [Fact]
    public void CameraClip_DefaultDuration_Is3s() =>
        RateLimit.CameraClipDefaultDurationMs.Should().Be(3_000);

    [Fact]
    public void CameraSnap_MinDelay_Is0() =>
        RateLimit.CameraSnapMinDelayMs.Should().Be(0);

    [Fact]
    public void CameraSnap_MaxDelay_Is10s() =>
        RateLimit.CameraSnapMaxDelayMs.Should().Be(10_000);

    [Fact]
    public void CameraSnap_DefaultDelay_Is0() =>
        RateLimit.CameraSnapDefaultDelayMs.Should().Be(0);

    [Fact]
    public void ScreenRecord_MinLessThanMax()
    {
        RateLimit.ScreenRecordMinDurationMs.Should().BeLessThan(RateLimit.ScreenRecordMaxDurationMs);
        RateLimit.ScreenRecordMinFps.Should().BeLessThan(RateLimit.ScreenRecordMaxFps);
    }

    [Fact]
    public void CameraClip_MinLessThanMax() =>
        RateLimit.CameraClipMinDurationMs.Should().BeLessThan(RateLimit.CameraClipMaxDurationMs);

    [Fact]
    public void Defaults_InRange()
    {
        RateLimit.ScreenRecordDefaultDurationMs.Should()
            .BeInRange(RateLimit.ScreenRecordMinDurationMs, RateLimit.ScreenRecordMaxDurationMs);
        RateLimit.ScreenRecordDefaultFps.Should()
            .BeInRange(RateLimit.ScreenRecordMinFps, RateLimit.ScreenRecordMaxFps);
        RateLimit.CameraClipDefaultDurationMs.Should()
            .BeInRange(RateLimit.CameraClipMinDurationMs, RateLimit.CameraClipMaxDurationMs);
    }
}
