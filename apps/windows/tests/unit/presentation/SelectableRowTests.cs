using OpenClawWindows.Presentation.Components;
using Windows.UI;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SelectableRowTests
{
    private static readonly Color Accent = Color.FromArgb(255, 100, 149, 237); // sample accent

    // --- SelectedBackgroundColor ---

    [Fact]
    public void SelectedBackgroundColor_PreservesRgb()
    {
        var result = SelectableRow.SelectedBackgroundColor(Accent);
        Assert.Equal(Accent.R, result.R);
        Assert.Equal(Accent.G, result.G);
        Assert.Equal(Accent.B, result.B);
    }

    [Fact]
    public void SelectedBackgroundColor_Alpha_Is12Percent()
    {
        // Swift: accentColor.opacity(0.12) → round(0.12 * 255) = 31
        var result = SelectableRow.SelectedBackgroundColor(Accent);
        Assert.Equal((byte)31, result.A);
    }

    // --- SelectedBorderColor ---

    [Fact]
    public void SelectedBorderColor_PreservesRgb()
    {
        var result = SelectableRow.SelectedBorderColor(Accent);
        Assert.Equal(Accent.R, result.R);
        Assert.Equal(Accent.G, result.G);
        Assert.Equal(Accent.B, result.B);
    }

    [Fact]
    public void SelectedBorderColor_Alpha_Is45Percent()
    {
        // Swift: accentColor.opacity(0.45) → round(0.45 * 255) = 115
        var result = SelectableRow.SelectedBorderColor(Accent);
        Assert.Equal((byte)115, result.A);
    }

    // --- HoveredBackgroundColor ---

    [Fact]
    public void HoveredBackgroundColor_Alpha_Is8Percent()
    {
        // Swift: Color.secondary.opacity(0.08) → round(0.08 * 255) = 20
        var result = SelectableRow.HoveredBackgroundColor();
        Assert.Equal((byte)20, result.A);
    }

    [Fact]
    public void HoveredBackgroundColor_IsNeutralGray()
    {
        // Adapts Swift Color.secondary — neutral mid-gray (128,128,128).
        var result = SelectableRow.HoveredBackgroundColor();
        Assert.Equal(128, result.R);
        Assert.Equal(128, result.G);
        Assert.Equal(128, result.B);
    }
}
