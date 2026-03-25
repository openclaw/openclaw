using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class MenuItemHighlightColorsTests
{
    // ── Alpha constants ───────────────────────────────────────────────────────

    [Fact]
    public void HighlightedSecondaryAlpha_Is0xD9()
    {
        // Mirrors .opacity(0.85): 0.85 × 255 ≈ 217 = 0xD9
        Assert.Equal((byte)0xD9, MenuItemHighlightColors.HighlightedSecondaryAlpha);
    }

    [Fact]
    public void NormalSecondaryAlpha_Is0x99()
    {
        // SwiftUI .secondary ≈ 60% opacity: 0.60 × 255 ≈ 153 = 0x99
        Assert.Equal((byte)0x99, MenuItemHighlightColors.NormalSecondaryAlpha);
    }

    // ── Primary ───────────────────────────────────────────────────────────────

    [Fact]
    public void Primary_Highlighted_IsWhite()
    {
        // Mirrors: NSColor.selectedMenuItemTextColor → white
        var c = MenuItemHighlightColors.Primary(highlighted: true);
        Assert.Equal(0xFF, c.A);
        Assert.Equal(0xFF, c.R);
        Assert.Equal(0xFF, c.G);
        Assert.Equal(0xFF, c.B);
    }

    [Fact]
    public void Primary_Normal_IsOpaqueBlack()
    {
        // Mirrors: SwiftUI .primary → opaque black (light-mode menu default)
        var c = MenuItemHighlightColors.Primary(highlighted: false);
        Assert.Equal(0xFF, c.A);
        Assert.Equal(0x00, c.R);
        Assert.Equal(0x00, c.G);
        Assert.Equal(0x00, c.B);
    }

    // ── Secondary ─────────────────────────────────────────────────────────────

    [Fact]
    public void Secondary_Highlighted_IsWhiteAt85Percent()
    {
        // Mirrors: selectedMenuItemTextColor.opacity(0.85)
        var c = MenuItemHighlightColors.Secondary(highlighted: true);
        Assert.Equal(0xD9, c.A);
        Assert.Equal(0xFF, c.R);
        Assert.Equal(0xFF, c.G);
        Assert.Equal(0xFF, c.B);
    }

    [Fact]
    public void Secondary_Normal_IsBlackAt60Percent()
    {
        // Mirrors: SwiftUI .secondary ≈ 60% label color
        var c = MenuItemHighlightColors.Secondary(highlighted: false);
        Assert.Equal(0x99, c.A);
        Assert.Equal(0x00, c.R);
        Assert.Equal(0x00, c.G);
        Assert.Equal(0x00, c.B);
    }

    // ── Palette ───────────────────────────────────────────────────────────────

    [Fact]
    public void GetPalette_Highlighted_PrimaryIsWhite()
    {
        var palette = MenuItemHighlightColors.GetPalette(highlighted: true);
        Assert.Equal(0xFF, palette.Primary.R);
        Assert.Equal(0xFF, palette.Primary.G);
        Assert.Equal(0xFF, palette.Primary.B);
    }

    [Fact]
    public void GetPalette_Normal_SecondaryAlphaIs0x99()
    {
        var palette = MenuItemHighlightColors.GetPalette(highlighted: false);
        Assert.Equal((byte)0x99, palette.Secondary.A);
    }
}
