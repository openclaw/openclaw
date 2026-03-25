using OpenClawWindows.Presentation.Voice;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class VoiceOverlayTextFormatterTests
{
    // --- Delta ---
    // Mirrors Swift: VoiceOverlayTextFormatting.delta(after:current:)

    [Fact]
    public void Delta_ReturnsRemainder_WhenCurrentStartsWithCommitted()
    {
        Assert.Equal(" world", VoiceOverlayTextFormatter.Delta("hello", "hello world"));
    }

    [Fact]
    public void Delta_ReturnsFullCurrent_WhenNoCommonPrefix()
    {
        // Mirrors Swift: else { return current }
        Assert.Equal("world", VoiceOverlayTextFormatter.Delta("hello", "world"));
    }

    [Fact]
    public void Delta_ReturnsEmpty_WhenCurrentEqualsCommitted()
    {
        Assert.Equal("", VoiceOverlayTextFormatter.Delta("hello", "hello"));
    }

    [Fact]
    public void Delta_ReturnsEmpty_WhenBothEmpty()
    {
        Assert.Equal("", VoiceOverlayTextFormatter.Delta("", ""));
    }

    [Fact]
    public void Delta_ReturnsCurrent_WhenCommittedEmpty()
    {
        Assert.Equal("anything", VoiceOverlayTextFormatter.Delta("", "anything"));
    }

    [Fact]
    public void Delta_IsCaseSensitive()
    {
        // OrdinalComparison: "Hello" ≠ "hello"
        Assert.Equal("hello world", VoiceOverlayTextFormatter.Delta("Hello", "hello world"));
    }

    // --- FontSize constant ---

    [Fact]
    public void FontSize_Is13()
    {
        // Mirrors Swift: NSFont.systemFont(ofSize: 13)
        Assert.Equal(13.0, VoiceOverlayTextFormatter.FontSize);
    }

    // --- VolatileDimColor ---
    // Adapts Swift: NSColor.tertiaryLabelColor → neutral gray at ~40% opacity

    [Fact]
    public void VolatileDimColor_IsNeutralGray()
    {
        var c = VoiceOverlayTextFormatter.VolatileDimColor;
        Assert.Equal(0x80, c.R);
        Assert.Equal(0x80, c.G);
        Assert.Equal(0x80, c.B);
    }

    [Fact]
    public void VolatileDimColor_Alpha_IsApprox40Percent()
    {
        // 0x66 = 102 ≈ 40% of 255 — adapts tertiaryLabelColor opacity
        Assert.Equal((byte)0x66, VoiceOverlayTextFormatter.VolatileDimColor.A);
    }
}
