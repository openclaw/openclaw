using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class MenuHeaderCardTests
{
    // ── Layout constants (mirrors MenuHeaderCard.swift exact values) ──────────

    [Fact]
    public void DefaultPaddingBottom_Is6() =>
        Assert.Equal(6.0, MenuHeaderCard.DefaultPaddingBottom);

    [Fact]
    public void PaddingTop_Is8() =>
        Assert.Equal(8.0, MenuHeaderCard.PaddingTop);

    [Fact]
    public void PaddingLeading_Is20() =>
        Assert.Equal(20.0, MenuHeaderCard.PaddingLeading);

    [Fact]
    public void PaddingTrailing_Is10() =>
        Assert.Equal(10.0, MenuHeaderCard.PaddingTrailing);

    [Fact]
    public void Spacing_Is6() =>
        Assert.Equal(6.0, MenuHeaderCard.Spacing);

    [Fact]
    public void MinWidthValue_Is300() =>
        // Mirrors frame(minWidth: 300, maxWidth: .infinity)
        Assert.Equal(300.0, MenuHeaderCard.MinWidthValue);

    [Fact]
    public void CaptionFontSize_Is11() =>
        // Adapts Swift .caption (≈ 12pt macOS) → 11px WinUI3 secondary text
        Assert.Equal(11.0, MenuHeaderCard.CaptionFontSize);
}
