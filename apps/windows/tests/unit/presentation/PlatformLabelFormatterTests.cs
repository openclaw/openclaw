using OpenClawWindows.Presentation.Formatters;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class PlatformLabelFormatterTests
{
    // Parse — empty/whitespace → ("", null)
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t")]
    public void Parse_ReturnsEmptyPrefix_WhenBlank(string raw)
    {
        var (prefix, version) = PlatformLabelFormatter.Parse(raw);
        Assert.Equal("", prefix);
        Assert.Null(version);
    }

    // Parse — single token → prefix lowercased, no version
    [Fact]
    public void Parse_ReturnsPrefixOnly_WhenSingleToken()
    {
        var (prefix, version) = PlatformLabelFormatter.Parse("macOS");
        Assert.Equal("macos", prefix);
        Assert.Null(version);
    }

    // Parse — two tokens → prefix + version
    [Fact]
    public void Parse_ReturnsPrefixAndVersion_WhenTwoTokens()
    {
        var (prefix, version) = PlatformLabelFormatter.Parse("macos 15.2.1");
        Assert.Equal("macos", prefix);
        Assert.Equal("15.2.1", version);
    }

    // Parse — splits on both space and tab
    [Fact]
    public void Parse_SplitsOnTab()
    {
        var (prefix, version) = PlatformLabelFormatter.Parse("ios\t18.0");
        Assert.Equal("ios", prefix);
        Assert.Equal("18.0", version);
    }

    // Pretty — empty → null
    [Fact]
    public void Pretty_ReturnsNull_WhenBlank()
        => Assert.Null(PlatformLabelFormatter.Pretty(""));

    // Pretty — known platform names
    [Theory]
    [InlineData("macos",   "macOS")]
    [InlineData("ios",     "iOS")]
    [InlineData("ipados",  "iPadOS")]
    [InlineData("tvos",    "tvOS")]
    [InlineData("watchos", "watchOS")]
    public void Pretty_ReturnsKnownName_WhenNoVersion(string raw, string expected)
        => Assert.Equal(expected, PlatformLabelFormatter.Pretty(raw));

    // Pretty — known platform + version with ≥2 parts → "Name X.Y"
    [Theory]
    [InlineData("macos 15.2.1", "macOS 15.2")]
    [InlineData("ios 18.0",     "iOS 18.0")]
    public void Pretty_TruncatesVersionToMajorMinor_WhenAtLeast2Parts(string raw, string expected)
        => Assert.Equal(expected, PlatformLabelFormatter.Pretty(raw));

    // Pretty — version with single part → "Name X"
    [Fact]
    public void Pretty_UsesWholeVersion_WhenSinglePart()
        => Assert.Equal("macOS 15", PlatformLabelFormatter.Pretty("macos 15"));

    // Pretty — unknown platform → capitalize first letter
    [Theory]
    [InlineData("linux",   "Linux")]
    [InlineData("windows", "Windows")]
    [InlineData("android", "Android")]
    public void Pretty_CapitalizesFirstLetter_WhenUnknownPlatform(string raw, string expected)
        => Assert.Equal(expected, PlatformLabelFormatter.Pretty(raw));

    // Pretty — unknown platform + version
    [Fact]
    public void Pretty_CapitalizesAndAppendsVersion_WhenUnknownWithVersion()
        => Assert.Equal("Linux 6.8", PlatformLabelFormatter.Pretty("linux 6.8.0"));
}
