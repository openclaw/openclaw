using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Tests.Unit.Domain.Camera;

public sealed class ScreenshotSizeTests
{
    // 1×1 white PNG — same base64 as the macOS test
    private const string OnePxPngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+WZxkAAAAASUVORK5CYII=";

    [Fact]
    public void ReadPngSize_ValidOnePxPng_ReturnsDimensions()
    {
        var data = Convert.FromBase64String(OnePxPngBase64);

        var size = ScreenshotSize.ReadPngSize(data);

        size.Should().NotBeNull();
        size!.Value.Width.Should().Be(1);
        size!.Value.Height.Should().Be(1);
    }

    [Fact]
    public void ReadPngSize_NonPngData_ReturnsNull()
    {
        var data = System.Text.Encoding.UTF8.GetBytes("nope");

        ScreenshotSize.ReadPngSize(data).Should().BeNull();
    }

    [Fact]
    public void ReadPngSize_NullData_ReturnsNull()
        => ScreenshotSize.ReadPngSize(null).Should().BeNull();

    [Fact]
    public void ReadPngSize_EmptyData_ReturnsNull()
        => ScreenshotSize.ReadPngSize([]).Should().BeNull();

    [Fact]
    public void ReadPngSize_TruncatedPng_ReturnsNull()
    {
        // Valid signature but no IHDR data
        byte[] truncated = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00];

        ScreenshotSize.ReadPngSize(truncated).Should().BeNull();
    }
}
