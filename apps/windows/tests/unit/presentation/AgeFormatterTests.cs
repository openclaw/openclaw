using OpenClawWindows.Presentation.Formatters;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class AgeFormatterTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);

    // Mirrors Swift: seconds < 60 → "just now"
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(59)]
    public void Age_ReturnsJustNow_WhenLessThan60Seconds(int seconds)
    {
        Assert.Equal("just now", AgeFormatter.Age(Now.AddSeconds(-seconds), Now));
    }

    // Mirrors Swift: minutes == 1 → "1 minute ago"
    [Fact]
    public void Age_Returns1MinuteAgo_WhenExactly60Seconds()
    {
        Assert.Equal("1 minute ago", AgeFormatter.Age(Now.AddSeconds(-60), Now));
    }

    // Mirrors Swift: minutes < 60 → "\(minutes)m ago"
    [Theory]
    [InlineData(2, "2m ago")]
    [InlineData(30, "30m ago")]
    [InlineData(59, "59m ago")]
    public void Age_ReturnsMinutesAgo_WhenLessThan60Minutes(int minutes, string expected)
    {
        Assert.Equal(expected, AgeFormatter.Age(Now.AddMinutes(-minutes), Now));
    }

    // Mirrors Swift: hours == 1 → "1 hour ago"
    [Fact]
    public void Age_Returns1HourAgo_WhenExactly60Minutes()
    {
        Assert.Equal("1 hour ago", AgeFormatter.Age(Now.AddMinutes(-60), Now));
    }

    // Mirrors Swift: hours < 24 → "\(hours)h ago"
    [Theory]
    [InlineData(2, "2h ago")]
    [InlineData(12, "12h ago")]
    [InlineData(23, "23h ago")]
    public void Age_ReturnsHoursAgo_WhenLessThan24Hours(int hours, string expected)
    {
        Assert.Equal(expected, AgeFormatter.Age(Now.AddHours(-hours), Now));
    }

    // Mirrors Swift: days == 1 → "yesterday"
    [Fact]
    public void Age_ReturnsYesterday_WhenExactly24Hours()
    {
        Assert.Equal("yesterday", AgeFormatter.Age(Now.AddHours(-24), Now));
    }

    // Mirrors Swift: else → "\(days)d ago"
    [Theory]
    [InlineData(2, "2d ago")]
    [InlineData(7, "7d ago")]
    [InlineData(365, "365d ago")]
    public void Age_ReturnsDaysAgo_WhenMoreThan1Day(int days, string expected)
    {
        Assert.Equal(expected, AgeFormatter.Age(Now.AddDays(-days), Now));
    }

    // Mirrors Swift: max(0, ...) — future dates clamped to "just now"
    [Fact]
    public void Age_ReturnsJustNow_WhenDateIsInTheFuture()
    {
        Assert.Equal("just now", AgeFormatter.Age(Now.AddSeconds(100), Now));
    }
}
