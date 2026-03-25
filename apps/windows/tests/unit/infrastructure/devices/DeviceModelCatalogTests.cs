using OpenClawWindows.Infrastructure.Devices;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Devices;

public sealed class DeviceModelCatalogTests
{
    // --- Symbol: model identifier prefix rules ---

    [Fact]
    public void Symbol_PrefersModelIdentifierPrefixes_iPad()
    {
        DeviceModelCatalog.Symbol("iPad", "iPad16,6", null).Should().Be("ipad");
    }

    [Fact]
    public void Symbol_PrefersModelIdentifierPrefixes_iPhone()
    {
        DeviceModelCatalog.Symbol("iPhone", "iPhone17,3", null).Should().Be("iphone");
    }

    [Fact]
    public void Symbol_IpodMapsToIphone()
    {
        DeviceModelCatalog.Symbol("iPod", "iPod9,1", null).Should().Be("iphone");
    }

    [Fact]
    public void Symbol_WatchMapsToAppleWatch()
    {
        DeviceModelCatalog.Symbol("Watch", "Watch7,1", null).Should().Be("applewatch");
    }

    [Fact]
    public void Symbol_AppleTvMapsToAppleTv()
    {
        DeviceModelCatalog.Symbol("TV", "AppleTV14,1", null).Should().Be("appletv");
    }

    [Fact]
    public void Symbol_HomePodMapsToSpeaker()
    {
        DeviceModelCatalog.Symbol("HomePod", "HomePod1,1", null).Should().Be("speaker");
    }

    [Fact]
    public void Symbol_AudioMapsToSpeaker()
    {
        DeviceModelCatalog.Symbol("", "AudioAccessory5,1", null).Should().Be("speaker");
    }

    [Fact]
    public void Symbol_MacBookMapsToLaptopComputer()
    {
        DeviceModelCatalog.Symbol("Mac", "MacBookPro18,1", null).Should().Be("laptopcomputer");
    }

    [Fact]
    public void Symbol_MacStudioMapsToMacStudio()
    {
        DeviceModelCatalog.Symbol("Mac", "MacStudio1,1", null).Should().Be("macstudio");
    }

    [Fact]
    public void Symbol_MacMiniMapsToMacMini()
    {
        DeviceModelCatalog.Symbol("Mac", "MacMini9,1", null).Should().Be("macmini");
    }

    [Fact]
    public void Symbol_IMacMapsToDesktopComputer()
    {
        DeviceModelCatalog.Symbol("Mac", "iMac21,1", null).Should().Be("desktopcomputer");
    }

    [Fact]
    public void Symbol_MacProMapsToDesktopComputer()
    {
        DeviceModelCatalog.Symbol("Mac", "MacPro7,1", null).Should().Be("desktopcomputer");
    }

    // --- Symbol: uses friendly name for generic Mac identifiers ---

    [Fact]
    public void Symbol_UsesFriendlyName_MacStudio()
    {
        DeviceModelCatalog.Symbol("Mac", "Mac99,1", "Mac Studio (2025)").Should().Be("macstudio");
    }

    [Fact]
    public void Symbol_UsesFriendlyName_MacMini()
    {
        DeviceModelCatalog.Symbol("Mac", "Mac99,2", "Mac mini (2024)").Should().Be("macmini");
    }

    [Fact]
    public void Symbol_UsesFriendlyName_MacBookPro()
    {
        DeviceModelCatalog.Symbol("Mac", "Mac99,3", "MacBook Pro (14-inch, 2024)").Should().Be("laptopcomputer");
    }

    // --- Symbol: fallback to device family ---

    [Fact]
    public void Symbol_FallsBackToFamily_Android()
    {
        DeviceModelCatalog.Symbol("Android", "", null).Should().Be("android");
    }

    [Fact]
    public void Symbol_FallsBackToFamily_Linux()
    {
        DeviceModelCatalog.Symbol("Linux", "", null).Should().Be("cpu");
    }

    [Fact]
    public void Symbol_FallsBackToFamily_Mac()
    {
        DeviceModelCatalog.Symbol("Mac", "", null).Should().Be("laptopcomputer");
    }

    [Fact]
    public void Symbol_UnknownFamily_ReturnsCpu()
    {
        DeviceModelCatalog.Symbol("SomethingElse", "", null).Should().Be("cpu");
    }

    [Fact]
    public void Symbol_EmptyFamily_EmptyModel_ReturnsNull()
    {
        DeviceModelCatalog.Symbol("", "", null).Should().BeNull();
    }

    // --- Presentation: uses bundled model mappings ---

    [Fact]
    public void Presentation_KnownIosModel_ReturnsTitle()
    {
        // iPhone1,1 → "iPhone" per ios-device-identifiers.json
        var result = DeviceModelCatalog.Presentation("iPhone", "iPhone1,1");
        result.Should().NotBeNull();
        result!.Title.Should().Be("iPhone");
    }

    [Fact]
    public void Presentation_UnknownModel_FallsBackToFamilyAndModel()
    {
        var result = DeviceModelCatalog.Presentation("iPhone", "iPhone99,99");
        result.Should().NotBeNull();
        result!.Title.Should().Be("iPhone (iPhone99,99)");
    }

    [Fact]
    public void Presentation_EmptyFamilyAndModel_ReturnsNull()
    {
        DeviceModelCatalog.Presentation(null, null).Should().BeNull();
        DeviceModelCatalog.Presentation("", "").Should().BeNull();
    }

    [Fact]
    public void Presentation_OnlyFamily_ReturnsFamily()
    {
        var result = DeviceModelCatalog.Presentation("Android", "");
        result.Should().NotBeNull();
        result!.Title.Should().Be("Android");
    }

    [Fact]
    public void Presentation_OnlyModel_ReturnsModel()
    {
        var result = DeviceModelCatalog.Presentation(null, "SomeDevice1,1");
        result.Should().NotBeNull();
        result!.Title.Should().Be("SomeDevice1,1");
    }
}
