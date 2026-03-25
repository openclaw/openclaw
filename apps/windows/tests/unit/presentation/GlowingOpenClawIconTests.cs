using OpenClawWindows.Presentation.Onboarding;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class GlowingOpenClawIconTests
{
    // Mirrors GlowingOpenClawIcon.swift default parameter values

    [Fact]
    public void DefaultSize_MatchesSwift()
    {
        // init(size: CGFloat = 148)
        Assert.Equal(148.0, GlowingOpenClawIcon.DefaultSize);
    }

    [Fact]
    public void DefaultGlowIntensity_MatchesSwift()
    {
        // init(glowIntensity: Double = 0.35)
        Assert.Equal(0.35, GlowingOpenClawIcon.DefaultGlowIntensity);
    }

    [Fact]
    public void GlowBlurRadius_MatchesSwift()
    {
        // let glowBlurRadius: CGFloat = 18
        Assert.Equal(18.0, GlowingOpenClawIcon.GlowBlurRadius);
    }

    [Fact]
    public void GlowOpacity_MatchesSwift()
    {
        // .opacity(0.84)
        Assert.Equal(0.84, GlowingOpenClawIcon.GlowOpacity);
    }

    [Fact]
    public void GlowScaleStart_MatchesSwift()
    {
        // .scaleEffect(breathe ? 1.08 : 0.96) — off state
        Assert.Equal(0.96, GlowingOpenClawIcon.GlowScaleStart);
    }

    [Fact]
    public void GlowScaleEnd_MatchesSwift()
    {
        // .scaleEffect(breathe ? 1.08 : 0.96) — on state
        Assert.Equal(1.08, GlowingOpenClawIcon.GlowScaleEnd);
    }

    [Fact]
    public void IconScaleStart_MatchesSwift()
    {
        // .scaleEffect(breathe ? 1.02 : 1.0) — off state
        Assert.Equal(1.00, GlowingOpenClawIcon.IconScaleStart);
    }

    [Fact]
    public void IconScaleEnd_MatchesSwift()
    {
        // .scaleEffect(breathe ? 1.02 : 1.0) — on state
        Assert.Equal(1.02, GlowingOpenClawIcon.IconScaleEnd);
    }

    [Fact]
    public void GlowCanvasSize_DefaultSize_EqualsSizePlusSizeBoost()
    {
        // let glowCanvasSize: CGFloat = self.size + 56  →  148 + 56 = 204
        Assert.Equal(204.0, GlowingOpenClawIcon.ComputeGlowCanvasSize(148));
    }

    [Fact]
    public void TotalSize_DefaultSize_EqualsGlowCanvasPlusTwoBlurRadii()
    {
        // frame(width: glowCanvasSize + (glowBlurRadius * 2), ...)  →  204 + 36 = 240
        Assert.Equal(240.0, GlowingOpenClawIcon.ComputeTotalSize(148));
    }

    [Fact]
    public void CornerRadius_DefaultSize_MatchesSwift()
    {
        // .clipShape(RoundedRectangle(cornerRadius: size * 0.22))  →  148 * 0.22 = 32.56
        Assert.Equal(148 * 0.22, GlowingOpenClawIcon.ComputeCornerRadius(148), precision: 10);
    }

    [Fact]
    public void StartAlpha_DefaultIntensity_MatchesSwift()
    {
        // accentColor.opacity(0.35) → alpha = (byte)(0.35 * 255) = 89
        Assert.Equal((byte)(0.35 * 255), GlowingOpenClawIcon.ComputeStartAlpha(0.35));
    }

    [Fact]
    public void EndAlpha_DefaultIntensity_MatchesSwift()
    {
        // blue.opacity(0.35 * 0.6) → alpha = (byte)(0.21 * 255) = 53
        Assert.Equal((byte)(0.35 * 0.6 * 255), GlowingOpenClawIcon.ComputeEndAlpha(0.35));
    }

    [Fact]
    public void TotalSize_ScalesWithSize()
    {
        // For size=200: glowCanvas=256, total=256+36=292
        Assert.Equal(292.0, GlowingOpenClawIcon.ComputeTotalSize(200));
    }
}
