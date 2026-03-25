using System.Text.Json;
using OpenClawWindows.Domain.Usage;

namespace OpenClawWindows.Tests.Unit.Domain.Usage;

public sealed class UsageCostDataTests
{
    // ── FormatUsd ─────────────────────────────────────────────────────────────

    [Fact]
    public void FormatUsd_Null_ReturnsNull() =>
        CostUsageFormatting.FormatUsd(null).Should().BeNull();

    [Fact]
    public void FormatUsd_NaN_ReturnsNull() =>
        CostUsageFormatting.FormatUsd(double.NaN).Should().BeNull();

    [Fact]
    public void FormatUsd_Infinity_ReturnsNull() =>
        CostUsageFormatting.FormatUsd(double.PositiveInfinity).Should().BeNull();

    [Theory]
    [InlineData(1.0,   "$1.00")]
    [InlineData(1.5,   "$1.50")]
    [InlineData(10.0,  "$10.00")]
    [InlineData(0.5,   "$0.50")]
    [InlineData(0.01,  "$0.01")]
    public void FormatUsd_GteOneCent_ReturnsTwoDecimals(double value, string expected) =>
        CostUsageFormatting.FormatUsd(value).Should().Be(expected);

    [Theory]
    [InlineData(0.001,  "$0.0010")]
    [InlineData(0.0001, "$0.0001")]
    [InlineData(0.009,  "$0.0090")]
    public void FormatUsd_LessThanOneCent_ReturnsFourDecimals(double value, string expected) =>
        CostUsageFormatting.FormatUsd(value).Should().Be(expected);

    [Fact]
    public void FormatUsd_Zero_ReturnsTwoDecimals() =>
        // 0.0 >= 0.01 is false → 4 decimals
        CostUsageFormatting.FormatUsd(0.0).Should().Be("$0.0000");

    // ── FormatTokenCount ──────────────────────────────────────────────────────

    [Fact]
    public void FormatTokenCount_Null_ReturnsNull() =>
        CostUsageFormatting.FormatTokenCount(null).Should().BeNull();

    [Theory]
    [InlineData(0,   "0")]
    [InlineData(1,   "1")]
    [InlineData(999, "999")]
    public void FormatTokenCount_BelowThousand_ReturnsInteger(int value, string expected) =>
        CostUsageFormatting.FormatTokenCount(value).Should().Be(expected);

    [Fact]
    public void FormatTokenCount_Negative_ClampsToZero() =>
        CostUsageFormatting.FormatTokenCount(-500).Should().Be("0");

    [Theory]
    [InlineData(1_000,  "1.0k")]
    [InlineData(1_500,  "1.5k")]
    [InlineData(9_999,  "10.0k")]   // rounds up in 1-decimal format
    [InlineData(5_000,  "5.0k")]
    public void FormatTokenCount_ThousandRange_ReturnsOneDecimalK(int value, string expected) =>
        CostUsageFormatting.FormatTokenCount(value).Should().Be(expected);

    [Theory]
    [InlineData(10_000,  "10k")]
    [InlineData(50_000,  "50k")]
    [InlineData(999_999, "1000k")]  // mirrors Swift: 999999/1000 = 999.999 → "%.0f" rounds to 1000
    public void FormatTokenCount_TenThousandRange_ReturnsZeroDecimalK(int value, string expected) =>
        CostUsageFormatting.FormatTokenCount(value).Should().Be(expected);

    [Theory]
    [InlineData(1_000_000, "1.0m")]
    [InlineData(1_500_000, "1.5m")]
    [InlineData(2_000_000, "2.0m")]
    public void FormatTokenCount_MillionRange_ReturnsOneDecimalM(int value, string expected) =>
        CostUsageFormatting.FormatTokenCount(value).Should().Be(expected);

    // ── GatewayCostUsageDay JSON round-trip ───────────────────────────────────

    [Fact]
    public void CostUsageDay_EncodesFlat_DecodesFlat()
    {
        // Verifies the flat JSON layout (no nested "totals" object).
        const string json = """
            {
              "date": "2026-01-15",
              "input": 100,
              "output": 200,
              "cacheRead": 50,
              "cacheWrite": 10,
              "totalTokens": 360,
              "totalCost": 0.0123,
              "missingCostEntries": 0
            }
            """;

        var day = JsonSerializer.Deserialize<GatewayCostUsageDay>(json)!;
        day.Date.Should().Be("2026-01-15");
        day.Input.Should().Be(100);
        day.Output.Should().Be(200);
        day.CacheRead.Should().Be(50);
        day.CacheWrite.Should().Be(10);
        day.TotalTokens.Should().Be(360);
        day.TotalCost.Should().BeApproximately(0.0123, 1e-9);
        day.MissingCostEntries.Should().Be(0);
    }

    [Fact]
    public void CostUsageDay_Encode_ProducesFlatJson()
    {
        var day = new GatewayCostUsageDay
        {
            Date = "2026-01-15",
            Input = 10, Output = 20, CacheRead = 5, CacheWrite = 1,
            TotalTokens = 36, TotalCost = 0.01, MissingCostEntries = 0
        };
        var json = JsonSerializer.Serialize(day);
        // Must NOT contain a nested "totals" object — flat layout only.
        json.Should().NotContain("\"totals\"");
        json.Should().Contain("\"input\"");
    }

    // ── GatewayCostUsageSummary JSON round-trip ───────────────────────────────

    [Fact]
    public void CostUsageSummary_DecodesCorrectly()
    {
        const string json = """
            {
              "updatedAt": 1700000000.0,
              "days": 7,
              "daily": [],
              "totals": {
                "input": 1000, "output": 2000, "cacheRead": 100,
                "cacheWrite": 50, "totalTokens": 3150, "totalCost": 1.23,
                "missingCostEntries": 0
              }
            }
            """;

        var summary = JsonSerializer.Deserialize<GatewayCostUsageSummary>(json)!;
        summary.Days.Should().Be(7);
        summary.Totals.TotalCost.Should().BeApproximately(1.23, 1e-9);
        summary.Totals.TotalTokens.Should().Be(3150);
        summary.Daily.Should().BeEmpty();
    }
}
