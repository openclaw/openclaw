using OpenClawWindows.Application.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Application;

public sealed class VoiceWakeHelpersTests
{
    // --- SanitizeTriggers ---

    [Fact]
    public void SanitizeTriggers_TrimsAndDropsEmpty()
    {
        var result = VoiceWakeHelpers.SanitizeTriggers(["  hi  ", " ", "\n", "there"]);
        Assert.Equal(["hi", "there"], result);
    }

    [Fact]
    public void SanitizeTriggers_FallsBackToDefaults_WhenAllEmpty()
    {
        var result = VoiceWakeHelpers.SanitizeTriggers(["   ", ""]);
        Assert.Equal(VoiceWakeHelpers.DefaultTriggers, result);
    }

    [Fact]
    public void SanitizeTriggers_FallsBackToDefaults_WhenInputEmpty()
    {
        var result = VoiceWakeHelpers.SanitizeTriggers([]);
        Assert.Equal(VoiceWakeHelpers.DefaultTriggers, result);
    }

    [Fact]
    public void SanitizeTriggers_TruncatesWordLength()
    {
        var longWord = new string('x', VoiceWakeHelpers.MaxWordLength + 5);
        var result = VoiceWakeHelpers.SanitizeTriggers(["ok", longWord]);
        Assert.Equal(VoiceWakeHelpers.MaxWordLength, result[1].Length);
    }

    [Fact]
    public void SanitizeTriggers_LimitsWordCount()
    {
        var words = Enumerable.Range(1, VoiceWakeHelpers.MaxWords + 3).Select(i => $"w{i}");
        var result = VoiceWakeHelpers.SanitizeTriggers(words);
        Assert.Equal(VoiceWakeHelpers.MaxWords, result.Count);
    }

    [Fact]
    public void SanitizeTriggers_PreservesWordsUnderLimit()
    {
        var result = VoiceWakeHelpers.SanitizeTriggers(["hello", "world"]);
        Assert.Equal(["hello", "world"], result);
    }

    // --- NormalizeLocaleIdentifier ---

    [Fact]
    public void NormalizeLocale_StripsCollation()
    {
        Assert.Equal("en_US", VoiceWakeHelpers.NormalizeLocaleIdentifier("en_US@collation=phonebook"));
    }

    [Fact]
    public void NormalizeLocale_StripsUnicodeExtension()
    {
        Assert.Equal("de-DE", VoiceWakeHelpers.NormalizeLocaleIdentifier("de-DE-u-co-phonebk"));
    }

    [Fact]
    public void NormalizeLocale_StripsTransformExtension()
    {
        Assert.Equal("ja-JP", VoiceWakeHelpers.NormalizeLocaleIdentifier("ja-JP-t-ja"));
    }

    [Fact]
    public void NormalizeLocale_PassesThroughCleanIdentifier()
    {
        Assert.Equal("en-US", VoiceWakeHelpers.NormalizeLocaleIdentifier("en-US"));
    }

    [Fact]
    public void NormalizeLocale_StripsUBeforeT_WhenBothPresent()
    {
        // -u- is stripped first, so -t- that follows it is gone with it; only one truncation needed.
        Assert.Equal("en", VoiceWakeHelpers.NormalizeLocaleIdentifier("en-u-ca-gregory-t-ja"));
    }
}
