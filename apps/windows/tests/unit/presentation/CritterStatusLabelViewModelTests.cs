using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Presentation.Tray;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class CritterStatusLabelViewModelTests
{
    // ── GatewayNeedsAttention — mirrors gatewayNeedsAttention computed var ────

    [Fact]
    public void GatewayNeedsAttention_WhenSleeping_ReturnsFalse()
    {
        // Mirrors: if self.isSleeping { return false }
        var result = CritterStatusLabelViewModel.ComputeGatewayNeedsAttention(
            GatewayProcessStatus.Failed("error"), isSleeping: true, isPaused: false);
        Assert.False(result);
    }

    [Theory]
    [InlineData(false, true)]   // not paused → needs attention
    [InlineData(true,  false)]  // paused → no attention (mirrors: return !self.isPaused)
    public void GatewayNeedsAttention_WhenFailed_DependsOnPaused(bool isPaused, bool expected)
    {
        var result = CritterStatusLabelViewModel.ComputeGatewayNeedsAttention(
            GatewayProcessStatus.Failed("boom"), isSleeping: false, isPaused: isPaused);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true,  false)]
    public void GatewayNeedsAttention_WhenStopped_DependsOnPaused(bool isPaused, bool expected)
    {
        var result = CritterStatusLabelViewModel.ComputeGatewayNeedsAttention(
            GatewayProcessStatus.Stopped(), isSleeping: false, isPaused: isPaused);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void GatewayNeedsAttention_WhenRunning_ReturnsFalse(bool isPaused)
    {
        // Mirrors: case .running, .attachedExisting, .starting: return false
        var result = CritterStatusLabelViewModel.ComputeGatewayNeedsAttention(
            GatewayProcessStatus.Running(null), isSleeping: false, isPaused: isPaused);
        Assert.False(result);
    }

    [Fact]
    public void GatewayNeedsAttention_WhenStarting_ReturnsFalse()
    {
        var result = CritterStatusLabelViewModel.ComputeGatewayNeedsAttention(
            GatewayProcessStatus.Starting(), isSleeping: false, isPaused: false);
        Assert.False(result);
    }

    [Fact]
    public void GatewayNeedsAttention_WhenAttachedExisting_ReturnsFalse()
    {
        var result = CritterStatusLabelViewModel.ComputeGatewayNeedsAttention(
            GatewayProcessStatus.AttachedExisting(null), isSleeping: false, isPaused: false);
        Assert.False(result);
    }

    // ── GatewayBadgeColor — mirrors gatewayBadgeColor computed var ───────────

    [Fact]
    public void GatewayBadgeColor_WhenFailed_IsRed()
    {
        // Mirrors: case .failed: .red — View maps BadgeColorKind.Red → Colors.Red at render time
        var color = CritterStatusLabelViewModel.ComputeGatewayBadgeColor(
            GatewayProcessStatus.Failed("oops"));
        Assert.Equal(BadgeColorKind.Red, color);
    }

    [Fact]
    public void GatewayBadgeColor_WhenStopped_IsOrange()
    {
        // Mirrors: case .stopped: .orange
        var color = CritterStatusLabelViewModel.ComputeGatewayBadgeColor(
            GatewayProcessStatus.Stopped());
        Assert.Equal(BadgeColorKind.Orange, color);
    }

    [Theory]
    [MemberData(nameof(NonBadgeStatuses))]
    public void GatewayBadgeColor_WhenRunningOrStarting_IsNone(GatewayProcessStatus status)
    {
        // Mirrors: default: .clear
        var color = CritterStatusLabelViewModel.ComputeGatewayBadgeColor(status);
        Assert.Equal(BadgeColorKind.None, color);
    }

    public static TheoryData<GatewayProcessStatus> NonBadgeStatuses =>
        new()
        {
            GatewayProcessStatus.Running(null),
            GatewayProcessStatus.Starting(),
            GatewayProcessStatus.AttachedExisting(null),
        };

    // ── EarScaleBoost / LegWiggleWorkingBoost — exact values from Swift ───────

    [Fact]
    public void EarScaleBoost_Is1Point9()
    {
        // Mirrors: earScale: earBoostActive ? 1.9 : 1.0
        Assert.Equal(1.9, CritterStatusLabelViewModel.EarScaleBoost);
    }

    [Fact]
    public void LegWiggleWorkingBoost_Is0Point6()
    {
        // Mirrors: max(self.legWiggle, self.isWorkingNow ? 0.6 : 0)
        Assert.Equal(0.6, CritterStatusLabelViewModel.LegWiggleWorkingBoost);
    }
}
