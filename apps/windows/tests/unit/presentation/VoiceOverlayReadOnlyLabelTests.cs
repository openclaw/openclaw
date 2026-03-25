using OpenClawWindows.Presentation.Voice;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class VoiceOverlayReadOnlyLabelTests
{
    // CoerceInputs ensures null committed/volatile never propagate to the formatter,
    // mirroring NSAttributedString which never carries nil spans.

    [Fact]
    public void CoerceInputs_NullCommitted_ReturnsEmpty()
    {
        var (c, _) = VoiceOverlayReadOnlyLabel.CoerceInputs(null, "partial");
        Assert.Equal(string.Empty, c);
    }

    [Fact]
    public void CoerceInputs_NullVolatile_ReturnsEmpty()
    {
        var (_, v) = VoiceOverlayReadOnlyLabel.CoerceInputs("done", null);
        Assert.Equal(string.Empty, v);
    }

    [Fact]
    public void CoerceInputs_NonNullValues_PassedThrough()
    {
        var (c, v) = VoiceOverlayReadOnlyLabel.CoerceInputs("hello", " world");
        Assert.Equal("hello", c);
        Assert.Equal(" world", v);
    }

    [Fact]
    public void CoerceInputs_BothNull_BothEmpty()
    {
        var (c, v) = VoiceOverlayReadOnlyLabel.CoerceInputs(null, null);
        Assert.Equal(string.Empty, c);
        Assert.Equal(string.Empty, v);
    }
}
