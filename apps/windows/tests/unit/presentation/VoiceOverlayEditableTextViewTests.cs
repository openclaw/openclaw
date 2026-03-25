using OpenClawWindows.Presentation.Voice;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class VoiceOverlayEditableTextViewTests
{
    // StripTrailingCarriageReturn removes the \r that RichEditBox appends to its
    // content, so EditedText matches the plain text the caller bound via Swift's
    // @Binding var text: String.

    [Fact]
    public void StripTrailingCarriageReturn_RemovesTrailingCr()
    {
        var result = VoiceOverlayEditableTextView.StripTrailingCarriageReturn("hello\r");
        Assert.Equal("hello", result);
    }

    [Fact]
    public void StripTrailingCarriageReturn_LeavesNoCrUntouched()
    {
        var result = VoiceOverlayEditableTextView.StripTrailingCarriageReturn("hello");
        Assert.Equal("hello", result);
    }

    [Fact]
    public void StripTrailingCarriageReturn_OnlyStripsLastCr()
    {
        // Embedded \r (from Shift+Enter newlines) must be preserved.
        var result = VoiceOverlayEditableTextView.StripTrailingCarriageReturn("line1\rline2\r");
        Assert.Equal("line1\rline2", result);
    }

    [Fact]
    public void StripTrailingCarriageReturn_EmptyString_ReturnsEmpty()
    {
        var result = VoiceOverlayEditableTextView.StripTrailingCarriageReturn(string.Empty);
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void StripTrailingCarriageReturn_OnlyCr_ReturnsEmpty()
    {
        var result = VoiceOverlayEditableTextView.StripTrailingCarriageReturn("\r");
        Assert.Equal(string.Empty, result);
    }
}
