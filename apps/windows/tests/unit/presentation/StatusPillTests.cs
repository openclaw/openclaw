using OpenClawWindows.Presentation.Components;
using Windows.UI;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class StatusPillTests
{
    // MakeBackgroundColor mirrors Swift tint.opacity(0.12):
    // same RGB as the tint, alpha = round(0.12 * 255) = 31.

    [Fact]
    public void MakeBackgroundColor_PreservesRgbChannels()
    {
        var tint = Color.FromArgb(255, 100, 150, 200);
        var result = StatusPill.MakeBackgroundColor(tint);
        Assert.Equal(100, result.R);
        Assert.Equal(150, result.G);
        Assert.Equal(200, result.B);
    }

    [Fact]
    public void MakeBackgroundColor_Alpha_Is12Percent()
    {
        // Swift: tint.opacity(0.12) → alpha = round(0.12 * 255) = 31.
        var tint = Color.FromArgb(255, 255, 0, 0);
        var result = StatusPill.MakeBackgroundColor(tint);
        Assert.Equal((byte)31, result.A);
    }

    [Fact]
    public void MakeBackgroundColor_IgnoresOriginalAlpha()
    {
        // Input alpha is irrelevant — output alpha is always the 12% constant.
        var tint = Color.FromArgb(128, 0, 200, 100);
        var result = StatusPill.MakeBackgroundColor(tint);
        Assert.Equal((byte)31, result.A);
    }
}
