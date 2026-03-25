using OpenClawWindows.Presentation.Formatters;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class DurationFormatterTests
{
    // Mirrors Swift: ms < 1000 → "{ms}ms"
    [Theory]
    [InlineData(0, "0ms")]
    [InlineData(1, "1ms")]
    [InlineData(999, "999ms")]
    public void ConciseDuration_ReturnsMilliseconds_WhenLessThan1000(int ms, string expected)
    {
        Assert.Equal(expected, DurationFormatter.ConciseDuration(ms));
    }

    // Mirrors Swift: s < 60 → "{round(s)}s"
    [Theory]
    [InlineData(1000, "1s")]
    [InlineData(1499, "1s")]
    [InlineData(1500, "2s")]
    [InlineData(59000, "59s")]
    public void ConciseDuration_ReturnsSeconds_WhenLessThan60Seconds(int ms, string expected)
    {
        Assert.Equal(expected, DurationFormatter.ConciseDuration(ms));
    }

    // Mirrors Swift: m < 60 → "{round(m)}m"
    [Theory]
    [InlineData(60000, "1m")]
    [InlineData(90000, "2m")]   // 1.5 min → round → 2
    [InlineData(3540000, "59m")]
    public void ConciseDuration_ReturnsMinutes_WhenLessThan60Minutes(int ms, string expected)
    {
        Assert.Equal(expected, DurationFormatter.ConciseDuration(ms));
    }

    // Mirrors Swift: h < 48 → "{round(h)}h"
    [Theory]
    [InlineData(3600000, "1h")]
    [InlineData(5400000, "2h")]   // 1.5 h → round → 2
    [InlineData(172800000 - 1, "48h")] // just under 48h (47.9999... → rounds to 48 but still < 48)
    public void ConciseDuration_ReturnsHours_WhenLessThan48Hours(int ms, string expected)
    {
        Assert.Equal(expected, DurationFormatter.ConciseDuration(ms));
    }

    // Mirrors Swift: else → "{round(d)}d"
    [Theory]
    [InlineData(172800000, "2d")]   // exactly 48h
    [InlineData(604800000, "7d")]   // 7 days
    public void ConciseDuration_ReturnsDays_WhenAtLeast48Hours(int ms, string expected)
    {
        Assert.Equal(expected, DurationFormatter.ConciseDuration(ms));
    }
}
