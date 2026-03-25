using OpenClawWindows.Domain.Usage;

namespace OpenClawWindows.Tests.Unit.Domain.Usage;

public sealed class UsageDataTests
{
    // ── HasError ──────────────────────────────────────────────────────────────

    [Fact]
    public void HasError_NullError_ReturnsFalse() =>
        MakeRow(error: null).HasError.Should().BeFalse();

    [Fact]
    public void HasError_EmptyError_ReturnsFalse() =>
        MakeRow(error: "").HasError.Should().BeFalse();

    [Fact]
    public void HasError_NonEmptyError_ReturnsTrue() =>
        MakeRow(error: "quota exceeded").HasError.Should().BeTrue();

    // ── TitleText ─────────────────────────────────────────────────────────────

    [Fact]
    public void TitleText_WithPlan_IncludesPlanInParens() =>
        MakeRow(displayName: "OpenAI", plan: "Pro").TitleText.Should().Be("OpenAI (Pro)");

    [Fact]
    public void TitleText_NullPlan_ReturnsDisplayName() =>
        MakeRow(displayName: "Anthropic", plan: null).TitleText.Should().Be("Anthropic");

    [Fact]
    public void TitleText_EmptyPlan_ReturnsDisplayName() =>
        MakeRow(displayName: "Anthropic", plan: "").TitleText.Should().Be("Anthropic");

    // ── RemainingPercent ──────────────────────────────────────────────────────

    [Fact]
    public void RemainingPercent_NullUsed_ReturnsNull() =>
        MakeRow(usedPercent: null).RemainingPercent.Should().BeNull();

    [Fact]
    public void RemainingPercent_NaN_ReturnsNull() =>
        MakeRow(usedPercent: double.NaN).RemainingPercent.Should().BeNull();

    [Fact]
    public void RemainingPercent_Infinity_ReturnsNull() =>
        MakeRow(usedPercent: double.PositiveInfinity).RemainingPercent.Should().BeNull();

    [Theory]
    [InlineData(0,   100)]
    [InlineData(25,  75)]
    [InlineData(75,  25)]
    [InlineData(100, 0)]
    public void RemainingPercent_Normal(double used, int expected) =>
        MakeRow(usedPercent: used).RemainingPercent.Should().Be(expected);

    [Fact]
    public void RemainingPercent_OverHundred_ClampedToZero() =>
        MakeRow(usedPercent: 120).RemainingPercent.Should().Be(0);

    [Fact]
    public void RemainingPercent_Negative_ClampedToHundred() =>
        MakeRow(usedPercent: -10).RemainingPercent.Should().Be(100);

    [Fact]
    public void RemainingPercent_RoundsHalfUp() =>
        // 100 - 74.5 = 25.5 → rounds to 26
        MakeRow(usedPercent: 74.5).RemainingPercent.Should().Be(26);

    // ── DetailText ────────────────────────────────────────────────────────────

    [Fact]
    public void DetailText_NullUsed_ReturnsNoData() =>
        MakeRow(usedPercent: null).DetailText().Should().Be("No data");

    [Fact]
    public void DetailText_ZeroUsed_NoWindow_NoReset() =>
        MakeRow(usedPercent: 0).DetailText().Should().Be("100% left");

    [Fact]
    public void DetailText_IncludesWindowLabel() =>
        MakeRow(usedPercent: 50, windowLabel: "Monthly")
            .DetailText().Should().Be("50% left · Monthly");

    [Fact]
    public void DetailText_IncludesResetWhenFuture()
    {
        var now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        var reset = now.AddMinutes(30);
        var row = MakeRow(usedPercent: 50, resetAt: reset);
        row.DetailText(now).Should().Be("50% left · ⏱30m");
    }

    [Fact]
    public void DetailText_SkipsResetWhenPast()
    {
        var now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        var reset = now.AddMinutes(-5); // already past
        var row = MakeRow(usedPercent: 50, resetAt: reset);
        // "now" is still appended (formatResetRemaining returns "now" for diff ≤ 0)
        row.DetailText(now).Should().Be("50% left · ⏱now");
    }

    // ── FormatResetRemaining (via DetailText) ─────────────────────────────────

    [Fact]
    public void FormatReset_ExactlyNow_ReturnsNow()
    {
        var now = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        MakeRow(usedPercent: 0, resetAt: now).DetailText(now).Should().Contain("⏱now");
    }

    [Fact]
    public void FormatReset_45Minutes_Returns45m()
    {
        var now = DateTimeOffset.UtcNow;
        MakeRow(usedPercent: 0, resetAt: now.AddMinutes(45)).DetailText(now).Should().Contain("⏱45m");
    }

    [Fact]
    public void FormatReset_2h30m_Returns2h30m()
    {
        var now = DateTimeOffset.UtcNow;
        MakeRow(usedPercent: 0, resetAt: now.AddHours(2).AddMinutes(30)).DetailText(now).Should().Contain("⏱2h 30m");
    }

    [Fact]
    public void FormatReset_3h0m_Returns3h()
    {
        var now = DateTimeOffset.UtcNow;
        MakeRow(usedPercent: 0, resetAt: now.AddHours(3)).DetailText(now).Should().Contain("⏱3h");
    }

    [Fact]
    public void FormatReset_3Days_Returns3d()
    {
        var now = DateTimeOffset.UtcNow;
        MakeRow(usedPercent: 0, resetAt: now.AddDays(3).AddHours(2)).DetailText(now).Should().Contain("⏱3d");
    }

    [Fact]
    public void FormatReset_10Days_ReturnsMonthDay()
    {
        var now = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var target = now.AddDays(10); // Jan 11
        MakeRow(usedPercent: 0, resetAt: target).DetailText(now).Should().Contain("⏱Jan 11");
    }

    // ── PrimaryRows ───────────────────────────────────────────────────────────

    [Fact]
    public void PrimaryRows_EmptyProviders_ReturnsEmpty()
    {
        var summary = new GatewayUsageSummary { Providers = [] };
        summary.PrimaryRows().Should().BeEmpty();
    }

    [Fact]
    public void PrimaryRows_ProviderWithNoWindows_IsSkipped()
    {
        var summary = new GatewayUsageSummary
        {
            Providers = [new GatewayUsageProvider { Provider = "x", DisplayName = "X", Windows = [] }]
        };
        summary.PrimaryRows().Should().BeEmpty();
    }

    [Fact]
    public void PrimaryRows_SelectsWindowWithHighestUsedPercent()
    {
        var summary = new GatewayUsageSummary
        {
            Providers =
            [
                new GatewayUsageProvider
                {
                    Provider = "openai",
                    DisplayName = "OpenAI",
                    Windows =
                    [
                        new GatewayUsageWindow { Label = "daily",   UsedPercent = 10 },
                        new GatewayUsageWindow { Label = "monthly", UsedPercent = 80 },
                        new GatewayUsageWindow { Label = "hourly",  UsedPercent = 5  },
                    ]
                }
            ]
        };

        var rows = summary.PrimaryRows();
        rows.Should().HaveCount(1);
        rows[0].WindowLabel.Should().Be("monthly");
        rows[0].UsedPercent.Should().Be(80);
    }

    [Fact]
    public void PrimaryRows_IdIsProviderDashLabel()
    {
        var summary = new GatewayUsageSummary
        {
            Providers =
            [
                new GatewayUsageProvider
                {
                    Provider = "anthropic",
                    DisplayName = "Anthropic",
                    Windows = [new GatewayUsageWindow { Label = "monthly", UsedPercent = 50 }]
                }
            ]
        };

        summary.PrimaryRows()[0].Id.Should().Be("anthropic-monthly");
    }

    [Fact]
    public void PrimaryRows_ResetAtConvertedFromEpochMs()
    {
        // Mirror: window.resetAt.map { Date(timeIntervalSince1970: $0 / 1000) }
        // 1_700_000_000_000 ms → DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000)
        var summary = new GatewayUsageSummary
        {
            Providers =
            [
                new GatewayUsageProvider
                {
                    Provider = "x",
                    DisplayName = "X",
                    Windows = [new GatewayUsageWindow { Label = "w", UsedPercent = 50, ResetAt = 1_700_000_000_000.0 }]
                }
            ]
        };

        var expected = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000L);
        summary.PrimaryRows()[0].ResetAt.Should().Be(expected);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static UsageRow MakeRow(
        double? usedPercent = 50,
        string? windowLabel = null,
        DateTimeOffset? resetAt = null,
        string? error = null,
        string displayName = "Provider",
        string? plan = null) =>
        new("id", "provider-id", displayName, plan, windowLabel, usedPercent, resetAt, error);
}
