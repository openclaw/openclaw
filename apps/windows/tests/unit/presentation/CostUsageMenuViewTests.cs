using System.Globalization;
using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class CostUsageMenuViewTests
{
    // ── CostUsageMenuDateParser.Parse — mirrors CostUsageMenuDateParser.parse(_:) ─

    [Theory]
    [InlineData("2024-01-15",  2024, 1, 15)]   // normal valid date
    [InlineData("2024-12-31",  2024, 12, 31)]  // year boundary
    [InlineData("2000-02-29",  2000, 2, 29)]   // leap day
    public void Parse_ValidDate_ReturnsDateTime(string input, int year, int month, int day)
    {
        var result = CostUsageMenuDateParser.Parse(input);

        Assert.NotNull(result);
        Assert.Equal(year,  result!.Value.Year);
        Assert.Equal(month, result!.Value.Month);
        Assert.Equal(day,   result!.Value.Day);
    }

    [Theory]
    [InlineData("")]            // empty
    [InlineData("not-a-date")] // garbage
    [InlineData("2024/01/15")] // wrong separator — mirrors compactMap nil guard
    [InlineData("15-01-2024")] // wrong order
    public void Parse_InvalidDate_ReturnsNull(string input)
    {
        // Mirrors: guard let date = CostUsageMenuDateParser.parse(entry.date) else { return nil }
        var result = CostUsageMenuDateParser.Parse(input);
        Assert.Null(result);
    }

    // ── CostUsageMenuDateParser.Format — mirrors CostUsageMenuDateParser.format(_:) ─

    [Fact]
    public void Format_ProducesYyyyMmDd()
    {
        // Mirrors: formatter.string(from: date) with "yyyy-MM-dd" format
        var date   = new DateTime(2024, 3, 7, 0, 0, 0, DateTimeKind.Unspecified);
        var result = CostUsageMenuDateParser.Format(date);
        Assert.Equal("2024-03-07", result);
    }

    [Fact]
    public void Format_ThenParse_RoundTrips()
    {
        // Mirrors: format(Date()) used as key for daily lookup
        var original = new DateTime(2024, 11, 30, 0, 0, 0, DateTimeKind.Unspecified);
        var key      = CostUsageMenuDateParser.Format(original);
        var parsed   = CostUsageMenuDateParser.Parse(key);
        Assert.Equal(original, parsed);
    }

    // ── Sizing logic — mirrors .frame(width: max(1, self.width)) ─────────────

    [Theory]
    [InlineData(240.0, 240.0)]  // positive — unchanged
    [InlineData(0.0,   1.0)]    // zero → clamped to 1
    [InlineData(-5.0,  1.0)]    // negative → clamped to 1
    public void ApplySizing_ClampsToMinimumOne(double input, double expected)
    {
        var result = Math.Max(1.0, input);
        Assert.Equal(expected, result);
    }
}
