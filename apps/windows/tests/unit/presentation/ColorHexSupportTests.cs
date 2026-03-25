using Windows.UI;
using OpenClawWindows.Presentation.Helpers;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class ColorHexSupportTests
{
    // null / empty / whitespace → null
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ColorFromHex_ReturnsNull_WhenNullOrEmpty(string? raw)
        => Assert.Null(ColorHexSupport.ColorFromHex(raw));

    // Non-6-char hex → null
    [Theory]
    [InlineData("FFF")]
    [InlineData("1234567")]
    [InlineData("GGGGGG")]
    public void ColorFromHex_ReturnsNull_WhenInvalid(string raw)
        => Assert.Null(ColorHexSupport.ColorFromHex(raw));

    // Valid #RRGGBB
    [Fact]
    public void ColorFromHex_ParsesHashPrefixed()
    {
        var c = ColorHexSupport.ColorFromHex("#FF8800");
        Assert.NotNull(c);
        Assert.Equal(255, c!.Value.A);
        Assert.Equal(0xFF, c.Value.R);
        Assert.Equal(0x88, c.Value.G);
        Assert.Equal(0x00, c.Value.B);
    }

    // Valid RRGGBB (no hash)
    [Fact]
    public void ColorFromHex_ParsesWithoutHash()
    {
        var c = ColorHexSupport.ColorFromHex("0080FF");
        Assert.NotNull(c);
        Assert.Equal(0x00, c!.Value.R);
        Assert.Equal(0x80, c.Value.G);
        Assert.Equal(0xFF, c.Value.B);
    }

    // Black and white
    [Theory]
    [InlineData("#000000", 0x00, 0x00, 0x00)]
    [InlineData("#FFFFFF", 0xFF, 0xFF, 0xFF)]
    public void ColorFromHex_ParsesBlackAndWhite(string raw, byte r, byte g, byte b)
    {
        var c = ColorHexSupport.ColorFromHex(raw)!.Value;
        Assert.Equal(r, c.R);
        Assert.Equal(g, c.G);
        Assert.Equal(b, c.B);
        Assert.Equal(255, c.A);
    }

    // Lowercase hex accepted
    [Fact]
    public void ColorFromHex_AcceptsLowercase()
    {
        var c = ColorHexSupport.ColorFromHex("#ff8800");
        Assert.NotNull(c);
        Assert.Equal(0xFF, c!.Value.R);
    }
}
