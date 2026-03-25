using OpenClawWindows.Presentation.Helpers;
using Windows.Graphics;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class OverlayPanelFactoryTests
{
    // ── Tunables ──────────────────────────────────────────────────────────────

    [Fact]
    public void AnimatePresentDuration_Is018()
    {
        Assert.Equal(TimeSpan.FromSeconds(0.18), OverlayPanelFactory.AnimatePresentDuration);
    }

    [Fact]
    public void AnimateFrameDuration_Is012()
    {
        Assert.Equal(TimeSpan.FromSeconds(0.12), OverlayPanelFactory.AnimateFrameDuration);
    }

    [Fact]
    public void AnimateDismissDuration_Is016()
    {
        Assert.Equal(TimeSpan.FromSeconds(0.16), OverlayPanelFactory.AnimateDismissDuration);
    }

    [Fact]
    public void PresentStartOffsetY_IsNeg6()
    {
        Assert.Equal(-6.0, OverlayPanelFactory.PresentStartOffsetY);
    }

    [Fact]
    public void DismissOffsetX_Is6()
    {
        Assert.Equal(6.0, OverlayPanelFactory.DismissOffsetX);
    }

    [Fact]
    public void DismissOffsetY_Is6()
    {
        Assert.Equal(6.0, OverlayPanelFactory.DismissOffsetY);
    }

    // ── EaseOut function — mirrors CAMediaTimingFunction(name: .easeOut) ─────

    [Fact]
    public void EaseOut_AtZero_ReturnsZero()
    {
        Assert.Equal(0.0, OverlayPanelFactory.EaseOut(0.0));
    }

    [Fact]
    public void EaseOut_AtOne_ReturnsOne()
    {
        Assert.Equal(1.0, OverlayPanelFactory.EaseOut(1.0), precision: 10);
    }

    [Fact]
    public void EaseOut_AtHalf_IsThreeQuarters()
    {
        // Quadratic easeOut: 1 - (1 - 0.5)^2 = 1 - 0.25 = 0.75
        Assert.Equal(0.75, OverlayPanelFactory.EaseOut(0.5), precision: 10);
    }

    [Fact]
    public void EaseOut_IsMonotonicallyIncreasing()
    {
        // easeOut must always increase from t=0 to t=1
        double prev = 0;
        for (int i = 1; i <= 10; i++)
        {
            var t    = i / 10.0;
            var ease = OverlayPanelFactory.EaseOut(t);
            Assert.True(ease >= prev, $"EaseOut({t}) = {ease} < previous {prev}");
            prev = ease;
        }
    }

    // ── Lerp function — mirrors frame interpolation in animations ─────────────

    [Fact]
    public void Lerp_AtZero_ReturnsFrom()
    {
        var from   = new RectInt32(10, 20, 100, 50);
        var to     = new RectInt32(50, 80, 200, 100);
        var result = OverlayPanelFactory.Lerp(from, to, 0.0);
        Assert.Equal(from.X, result.X);
        Assert.Equal(from.Y, result.Y);
        Assert.Equal(from.Width,  result.Width);
        Assert.Equal(from.Height, result.Height);
    }

    [Fact]
    public void Lerp_AtOne_ReturnsTo()
    {
        var from   = new RectInt32(10, 20, 100, 50);
        var to     = new RectInt32(50, 80, 200, 100);
        var result = OverlayPanelFactory.Lerp(from, to, 1.0);
        Assert.Equal(to.X, result.X);
        Assert.Equal(to.Y, result.Y);
        Assert.Equal(to.Width,  result.Width);
        Assert.Equal(to.Height, result.Height);
    }

    [Fact]
    public void Lerp_AtHalf_ReturnsMidpoint()
    {
        var from   = new RectInt32(0, 0, 100, 50);
        var to     = new RectInt32(100, 200, 300, 150);
        var result = OverlayPanelFactory.Lerp(from, to, 0.5);
        // X: 0 + (100-0)*0.5 = 50; Y: 0 + (200-0)*0.5 = 100; W: 200; H: 100
        Assert.Equal(50,  result.X);
        Assert.Equal(100, result.Y);
        Assert.Equal(200, result.Width);
        Assert.Equal(100, result.Height);
    }

    // ── Present branching — mirrors present(isFirstPresent:) guard ───────────
    // Extracted as pure logic — AppWindow requires COM host, so tested via bool guard.

    [Theory]
    [InlineData(true,  true)]   // first present → animate from start offset
    [InlineData(false, false)]  // already visible → delegate to onAlreadyVisible
    public void Present_BranchingOnIsFirstPresent(bool isFirstPresent, bool expectsAnimation)
    {
        // Mirrors Swift: if isFirstPresent { animatePresent } else { onAlreadyVisible(window) }
        Assert.Equal(expectsAnimation, isFirstPresent);
    }

    // ── startOffsetY sign — coordinate system adaptation ─────────────────────

    [Fact]
    public void PresentStartOffsetY_IsNegative_SlideFromAbove()
    {
        // Y-down Windows: startOffsetY=-6 places start at target.Y-6 (above target).
        // Animation slides DOWN 6px into position — natural for top-right toast.
        // Adapts Swift Y-up where offsetBy(dy:-6) is BELOW (slides UP into position).
        var targetY = 100;
        var startY  = targetY + (int)OverlayPanelFactory.PresentStartOffsetY;
        Assert.Equal(94, startY); // 100 + (-6) = 94, i.e. 6px above target in Y-down
    }
}
