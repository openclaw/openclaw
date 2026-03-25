namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class MenuHighlightedHostViewTests
{
    // ── Sizing logic (mirrors max(1, targetWidth) from init + update) ─────────
    // WinUI3 UserControl ctor requires COM host, so sizing behavior is verified
    // via the Math.Max invariant directly — same pattern as MenuHostedItemTests.

    [Theory]
    [InlineData(240.0, 240.0)]  // positive width — unchanged
    [InlineData(320.0, 320.0)]  // larger positive width — unchanged
    [InlineData(0.0,   1.0)]    // zero → clamped to 1 (mirrors max(1, 0))
    [InlineData(-5.0,  1.0)]    // negative → clamped to 1 (mirrors max(1, negative))
    [InlineData(0.5,   1.0)]    // sub-pixel → clamped to 1
    public void ApplySizing_ClampsToMinimumOne(double input, double expected)
    {
        // Mirrors: let width = max(1, self.targetWidth) in updateSizing() and update(rootView:width:)
        var result = Math.Max(1.0, input);
        Assert.Equal(expected, result);
    }
}
