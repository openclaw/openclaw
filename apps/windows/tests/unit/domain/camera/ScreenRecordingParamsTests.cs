namespace OpenClawWindows.Tests.Unit.Domain.Camera;

public sealed class ScreenRecordingParamsTests
{
    // ── Valid cases ─────────────────────────────────────────────────────────

    [Fact]
    public void FromJson_DefaultsApplied_WhenFieldsOmitted()
    {
        var result = ScreenRecordingParams.FromJson("{}");

        result.IsError.Should().BeFalse();
        result.Value.Format.Should().Be("mp4");
        result.Value.DurationMs.Should().Be(RateLimit.ScreenRecordDefaultDurationMs);
        result.Value.Fps.Should().Be(RateLimit.ScreenRecordDefaultFps);
    }

    [Fact]
    public void FromJson_ExplicitValues_Parsed()
    {
        var result = ScreenRecordingParams.FromJson(
            """{"format":"mp4","durationMs":5000,"fps":30,"screenIndex":1,"includeAudio":true}""");

        result.IsError.Should().BeFalse();
        result.Value.DurationMs.Should().Be(5000);
        result.Value.Fps.Should().Be(30);
        result.Value.ScreenIndex.Should().Be(1);
        result.Value.IncludeAudio.Should().BeTrue();
    }

    // ── Error cases — macOS canonical error strings ─────────────────────────

    [Fact]
    public void FromJson_NonMp4Format_ReturnsFormatError()
    {
        // "INVALID_REQUEST: screen format must be mp4" — canonical macOS error
        var result = ScreenRecordingParams.FromJson("""{"format":"avi"}""");

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void FromJson_DurationBelowMin_ReturnsError()
    {
        var result = ScreenRecordingParams.FromJson("""{"durationMs":249}""");
        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void FromJson_DurationAboveMax_ReturnsError()
    {
        var result = ScreenRecordingParams.FromJson("""{"durationMs":60001}""");
        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void FromJson_FpsBelowMin_ReturnsError()
    {
        var result = ScreenRecordingParams.FromJson("""{"fps":0}""");
        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void FromJson_FpsAboveMax_ReturnsError()
    {
        var result = ScreenRecordingParams.FromJson("""{"fps":61}""");
        result.IsError.Should().BeTrue();
    }

    [Theory]
    [InlineData(250)]
    [InlineData(10000)]
    [InlineData(60000)]
    public void FromJson_BoundaryDurations_Valid(int durationMs)
    {
        var json = $"{{\"durationMs\":{durationMs}}}";
        var result = ScreenRecordingParams.FromJson(json);
        result.IsError.Should().BeFalse();
    }

    [Theory]
    [InlineData(1)]
    [InlineData(10)]
    [InlineData(60)]
    public void FromJson_BoundaryFps_Valid(int fps)
    {
        var json = $"{{\"fps\":{fps}}}";
        var result = ScreenRecordingParams.FromJson(json);
        result.IsError.Should().BeFalse();
    }
}
