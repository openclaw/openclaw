using OpenClawWindows.Application.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Application;

public sealed class VoiceWakeTextUtilsTests
{
    // --- NormalizeToken ---

    [Fact]
    public void NormalizeToken_TrimsWhitespaceAndPunctuation()
    {
        Assert.Equal("hello", VoiceWakeTextUtils.NormalizeToken("  hello!  "));
    }

    [Fact]
    public void NormalizeToken_Lowercases()
    {
        Assert.Equal("openclaw", VoiceWakeTextUtils.NormalizeToken("OpenClaw"));
    }

    [Fact]
    public void NormalizeToken_EmptyInput_ReturnsEmpty()
    {
        Assert.Equal(string.Empty, VoiceWakeTextUtils.NormalizeToken(""));
    }

    [Fact]
    public void NormalizeToken_PunctuationOnly_ReturnsEmpty()
    {
        Assert.Equal(string.Empty, VoiceWakeTextUtils.NormalizeToken("..."));
    }

    // --- StartsWithTrigger ---

    [Fact]
    public void StartsWithTrigger_SingleWordTrigger_MatchesPrefix()
    {
        Assert.True(VoiceWakeTextUtils.StartsWithTrigger("openclaw do thing", ["openclaw"]));
    }

    [Fact]
    public void StartsWithTrigger_TriggerNotAtStart_ReturnsFalse()
    {
        Assert.False(VoiceWakeTextUtils.StartsWithTrigger("do openclaw thing", ["openclaw"]));
    }

    [Fact]
    public void StartsWithTrigger_EmptyTranscript_ReturnsFalse()
    {
        Assert.False(VoiceWakeTextUtils.StartsWithTrigger("", ["openclaw"]));
    }

    [Fact]
    public void StartsWithTrigger_MultiWordTrigger_MatchesAllTokens()
    {
        Assert.True(VoiceWakeTextUtils.StartsWithTrigger("hey openclaw do thing", ["hey openclaw"]));
    }

    [Fact]
    public void StartsWithTrigger_MultiWordTrigger_PartialMatchFails()
    {
        Assert.False(VoiceWakeTextUtils.StartsWithTrigger("hey do thing", ["hey openclaw"]));
    }

    [Fact]
    public void StartsWithTrigger_CaseInsensitive()
    {
        Assert.True(VoiceWakeTextUtils.StartsWithTrigger("OpenClaw do thing", ["openclaw"]));
    }

    [Fact]
    public void StartsWithTrigger_PunctuationAroundToken_StillMatches()
    {
        Assert.True(VoiceWakeTextUtils.StartsWithTrigger("openclaw, do thing", ["openclaw"]));
    }

    [Fact]
    public void StartsWithTrigger_AnyTriggerMatches()
    {
        Assert.True(VoiceWakeTextUtils.StartsWithTrigger("claude do thing", ["openclaw", "claude"]));
    }

    // --- TextOnlyCommand ---

    [Fact]
    public void TextOnlyCommand_ValidInput_ReturnsStrippedCommand()
    {
        var result = VoiceWakeTextUtils.TextOnlyCommand(
            "openclaw do thing",
            ["openclaw"],
            minCommandLength: 1,
            (t, _) => "do thing");
        Assert.Equal("do thing", result);
    }

    [Fact]
    public void TextOnlyCommand_EmptyTranscript_ReturnsNull()
    {
        Assert.Null(VoiceWakeTextUtils.TextOnlyCommand("", ["openclaw"], 1, (t, _) => t));
    }

    [Fact]
    public void TextOnlyCommand_TriggerNotAtStart_ReturnsNull()
    {
        var result = VoiceWakeTextUtils.TextOnlyCommand(
            "do openclaw thing",
            ["openclaw"],
            minCommandLength: 1,
            (t, _) => "thing");
        Assert.Null(result);
    }

    [Fact]
    public void TextOnlyCommand_CommandBelowMinLength_ReturnsNull()
    {
        var result = VoiceWakeTextUtils.TextOnlyCommand(
            "openclaw do",
            ["openclaw"],
            minCommandLength: 10,
            (t, _) => "do");
        Assert.Null(result);
    }

    [Fact]
    public void TextOnlyCommand_CustomGateRejectsAll_ReturnsNull()
    {
        var result = VoiceWakeTextUtils.TextOnlyCommand(
            "openclaw do thing",
            ["openclaw"],
            minCommandLength: 1,
            (t, _) => "do thing",
            matchesTextOnly: (_, _) => false);
        Assert.Null(result);
    }

    [Fact]
    public void TextOnlyCommand_WhitespaceOnlyTranscript_ReturnsNull()
    {
        Assert.Null(VoiceWakeTextUtils.TextOnlyCommand("   ", ["openclaw"], 1, (t, _) => t));
    }
}
