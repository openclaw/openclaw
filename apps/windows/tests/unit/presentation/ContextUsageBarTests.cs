using OpenClawWindows.Presentation.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class ContextUsageBarTests
{
    // ── ComputeFraction — mirrors Swift: clampedFractionUsed ──────────────────

    [Fact]
    public void ComputeFraction_ZeroContext_ReturnsZero()
    {
        Assert.Equal(0.0, ContextUsageBarLogic.ComputeFraction(50, 0));
    }

    [Fact]
    public void ComputeFraction_NegativeContext_ReturnsZero()
    {
        Assert.Equal(0.0, ContextUsageBarLogic.ComputeFraction(50, -1));
    }

    [Fact]
    public void ComputeFraction_HalfUsed_ReturnsPreciseFraction()
    {
        Assert.Equal(0.5, ContextUsageBarLogic.ComputeFraction(50, 100));
    }

    [Fact]
    public void ComputeFraction_OverFull_ClampedToOne()
    {
        // mirrors Swift: min(1, max(0, ...))
        Assert.Equal(1.0, ContextUsageBarLogic.ComputeFraction(150, 100));
    }

    [Fact]
    public void ComputeFraction_NegativeUsed_ClampedToZero()
    {
        Assert.Equal(0.0, ContextUsageBarLogic.ComputeFraction(-10, 100));
    }

    // ── ComputePercentUsed — mirrors Swift: percentUsed ───────────────────────

    [Fact]
    public void ComputePercentUsed_ZeroContext_ReturnsNull()
    {
        Assert.Null(ContextUsageBarLogic.ComputePercentUsed(50, 0));
    }

    [Fact]
    public void ComputePercentUsed_ZeroUsed_ReturnsNull()
    {
        // mirrors Swift: guard usedTokens > 0
        Assert.Null(ContextUsageBarLogic.ComputePercentUsed(0, 100));
    }

    [Fact]
    public void ComputePercentUsed_HalfUsed_Returns50()
    {
        Assert.Equal(50, ContextUsageBarLogic.ComputePercentUsed(50, 100));
    }

    [Fact]
    public void ComputePercentUsed_OverFull_ClampedTo100()
    {
        // mirrors Swift: min(100, ...)
        Assert.Equal(100, ContextUsageBarLogic.ComputePercentUsed(200, 100));
    }

    [Fact]
    public void ComputePercentUsed_RoundsCorrectly()
    {
        Assert.Equal(33, ContextUsageBarLogic.ComputePercentUsed(33, 100));
    }

    // ── ComputeTintColor — mirrors Swift: tint ────────────────────────────────

    [Fact]
    public void ComputeTintColor_NullPercent_ReturnsSecondary()
    {
        Assert.Equal(ContextUsageBarLogic.TintSecondary,
            ContextUsageBarLogic.ComputeTintColor(null, false));
    }

    [Fact]
    public void ComputeTintColor_AtRedThreshold_ReturnsRed()
    {
        // mirrors Swift: pct >= 95 → systemRed
        Assert.Equal(ContextUsageBarLogic.TintRed, ContextUsageBarLogic.ComputeTintColor(95, false));
        Assert.Equal(ContextUsageBarLogic.TintRed, ContextUsageBarLogic.ComputeTintColor(100, false));
    }

    [Fact]
    public void ComputeTintColor_AtOrangeThreshold_ReturnsOrange()
    {
        Assert.Equal(ContextUsageBarLogic.TintOrange, ContextUsageBarLogic.ComputeTintColor(80, false));
        Assert.Equal(ContextUsageBarLogic.TintOrange, ContextUsageBarLogic.ComputeTintColor(94, false));
    }

    [Fact]
    public void ComputeTintColor_AtYellowThreshold_ReturnsYellow()
    {
        Assert.Equal(ContextUsageBarLogic.TintYellow, ContextUsageBarLogic.ComputeTintColor(60, false));
        Assert.Equal(ContextUsageBarLogic.TintYellow, ContextUsageBarLogic.ComputeTintColor(79, false));
    }

    [Fact]
    public void ComputeTintColor_BelowYellow_Dark_ReturnsGreenDark()
    {
        // mirrors Swift: dark mode → plain systemGreen
        Assert.Equal(ContextUsageBarLogic.TintGreenDark, ContextUsageBarLogic.ComputeTintColor(59, true));
        Assert.Equal(ContextUsageBarLogic.TintGreenDark, ContextUsageBarLogic.ComputeTintColor(1, true));
    }

    [Fact]
    public void ComputeTintColor_BelowYellow_Light_ReturnsGreenLight()
    {
        // mirrors Swift: okGreen = systemGreen.blended(withFraction: 0.24, of: .black)
        Assert.Equal(ContextUsageBarLogic.TintGreenLight, ContextUsageBarLogic.ComputeTintColor(59, false));
    }

    // ── ComputeFillWidth — mirrors Swift: fillWidth ───────────────────────────

    [Fact]
    public void ComputeFillWidth_HalfFraction_ReturnsFlooredHalf()
    {
        // mirrors Swift: max(1, floor(width * fraction))
        Assert.Equal(50.0, ContextUsageBarLogic.ComputeFillWidth(100.0, 0.5));
    }

    [Fact]
    public void ComputeFillWidth_ZeroFraction_ReturnsMinimum()
    {
        // mirrors Swift: max(1, floor(0)) = 1
        Assert.Equal(1.0, ContextUsageBarLogic.ComputeFillWidth(100.0, 0.0));
    }

    [Fact]
    public void ComputeFillWidth_FloorsTruncatedValues()
    {
        Assert.Equal(33.0, ContextUsageBarLogic.ComputeFillWidth(100.0, 0.333));
    }

    [Fact]
    public void ComputeFillWidth_ZeroWidth_ReturnsMinimum()
    {
        Assert.Equal(1.0, ContextUsageBarLogic.ComputeFillWidth(0.0, 0.5));
    }

    // ── ComputeAccessibilityValue — mirrors Swift: accessibilityValue ──────────

    [Fact]
    public void AccessibilityValue_ZeroContext_ReturnsUnknown()
    {
        // mirrors Swift: contextTokens <= 0 → "Unknown context window"
        Assert.Equal("Unknown context window",
            ContextUsageBarLogic.ComputeAccessibilityValue(50, 0));
    }

    [Fact]
    public void AccessibilityValue_HalfUsed_Returns50PercentUsed()
    {
        // mirrors Swift: "\(pct) percent used"
        Assert.Equal("50 percent used",
            ContextUsageBarLogic.ComputeAccessibilityValue(50, 100));
    }

    [Fact]
    public void AccessibilityValue_ZeroUsed_Returns0PercentUsed()
    {
        // mirrors Swift: uses clampedFractionUsed (not percentUsed?), so 0 → "0 percent used"
        Assert.Equal("0 percent used",
            ContextUsageBarLogic.ComputeAccessibilityValue(0, 100));
    }

    // ── Constant values — exact mirrors of Swift ──────────────────────────────

    [Fact]
    public void TrackFillAlpha_MatchesSwiftValues()
    {
        Assert.Equal((byte)36, ContextUsageBarLogic.TrackFillAlphaDark);   // 0.14 * 255
        Assert.Equal((byte)31, ContextUsageBarLogic.TrackFillAlphaLight);  // 0.12 * 255
    }

    [Fact]
    public void TrackStrokeAlpha_MatchesSwiftValues()
    {
        Assert.Equal((byte)56, ContextUsageBarLogic.TrackStrokeAlphaDark);   // 0.22 * 255
        Assert.Equal((byte)51, ContextUsageBarLogic.TrackStrokeAlphaLight);  // 0.20 * 255
    }
}
