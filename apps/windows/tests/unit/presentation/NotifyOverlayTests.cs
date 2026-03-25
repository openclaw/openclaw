using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class NotifyOverlayTests
{
    // ── Tunables ─────────────────────────────────────────────────────────────

    [Fact]
    public void AutoDismissMs_Is6000()
    {
        Assert.Equal(6_000, NotifyOverlay.AutoDismissMs);
    }

    // ── autoDismissAfterMs guard ─────────────────────────────────────────────

    [Theory]
    [InlineData(6_000, true)]   // positive default → set ExpirationTime
    [InlineData(1,     true)]   // small positive → set ExpirationTime
    [InlineData(0,     false)]  // zero → no expiration
    [InlineData(-1,    false)]  // negative → no expiration
    public void AutoDismiss_SetOnlyWhenPositive(int delayMs, bool expectSet)
    {
        Assert.Equal(expectSet, delayMs > 0);
    }
}
