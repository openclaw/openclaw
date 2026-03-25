using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Presentation.Voice;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class VoiceWakeRecognitionDebugSupportTests
{
    // ── DefaultMinRepeatInterval ──────────────────────────────────────────────

    [Fact]
    public void DefaultMinRepeatInterval_Is250Ms()
    {
        Assert.Equal(TimeSpan.FromSeconds(0.25), VoiceWakeRecognitionDebugSupport.DefaultMinRepeatInterval);
    }

    // ── ShouldLogTranscript ───────────────────────────────────────────────────

    [Fact]
    public void ShouldLog_EmptyTranscript_ReturnsFalse()
    {
        string? lastText = null;
        DateTimeOffset? lastAt = null;
        Assert.False(VoiceWakeRecognitionDebugSupport.ShouldLogTranscript(
            "", isFinal: false, LogLevel.Debug, ref lastText, ref lastAt));
    }

    [Theory]
    [InlineData(LogLevel.Information)]
    [InlineData(LogLevel.Warning)]
    [InlineData(LogLevel.Error)]
    [InlineData(LogLevel.Critical)]
    [InlineData(LogLevel.None)]
    internal void ShouldLog_NonDebugLevel_ReturnsFalse(LogLevel level)
    {
        string? lastText = null;
        DateTimeOffset? lastAt = null;
        Assert.False(VoiceWakeRecognitionDebugSupport.ShouldLogTranscript(
            "hello", isFinal: false, level, ref lastText, ref lastAt));
    }

    [Theory]
    [InlineData(LogLevel.Debug)]
    [InlineData(LogLevel.Trace)]
    internal void ShouldLog_DebugOrTrace_NewTranscript_ReturnsTrue(LogLevel level)
    {
        string? lastText = null;
        DateTimeOffset? lastAt = null;
        Assert.True(VoiceWakeRecognitionDebugSupport.ShouldLogTranscript(
            "hello", isFinal: false, level, ref lastText, ref lastAt));
    }

    [Fact]
    public void ShouldLog_SameTranscript_NotFinal_WithinInterval_ReturnsFalse()
    {
        string? lastText = "hello";
        DateTimeOffset? lastAt = DateTimeOffset.UtcNow; // just set → within 0.25s
        Assert.False(VoiceWakeRecognitionDebugSupport.ShouldLogTranscript(
            "hello", isFinal: false, LogLevel.Debug, ref lastText, ref lastAt));
    }

    [Fact]
    public void ShouldLog_SameTranscript_IsFinal_ReturnsTrue()
    {
        // isFinal=true bypasses the repeat-interval check
        string? lastText = "hello";
        DateTimeOffset? lastAt = DateTimeOffset.UtcNow;
        Assert.True(VoiceWakeRecognitionDebugSupport.ShouldLogTranscript(
            "hello", isFinal: true, LogLevel.Debug, ref lastText, ref lastAt));
    }

    [Fact]
    public void ShouldLog_UpdatesLastLoggedText()
    {
        string? lastText = null;
        DateTimeOffset? lastAt = null;
        VoiceWakeRecognitionDebugSupport.ShouldLogTranscript(
            "hey claude", isFinal: false, LogLevel.Debug, ref lastText, ref lastAt);
        Assert.Equal("hey claude", lastText);
    }

    // ── TextOnlyFallbackMatch ─────────────────────────────────────────────────

    [Fact]
    public void TextOnlyFallbackMatch_Matches_ReturnsMatchWithZeroTiming()
    {
        var config = new WakeWordGateConfig(MinCommandLength: 1);
        var match = VoiceWakeRecognitionDebugSupport.TextOnlyFallbackMatch(
            "hey claude do something",
            ["hey claude"],
            config,
            TrimWake);

        Assert.NotNull(match);
        Assert.Equal(0.0, match!.TriggerEndTime);
        Assert.Equal(0.0, match.PostGap);
        Assert.Equal("do something", match.Command);
    }

    [Fact]
    public void TextOnlyFallbackMatch_NoMatch_ReturnsNull()
    {
        var config = new WakeWordGateConfig(MinCommandLength: 1);
        var match = VoiceWakeRecognitionDebugSupport.TextOnlyFallbackMatch(
            "unrelated text",
            ["hey claude"],
            config,
            TrimWake);

        Assert.Null(match);
    }

    // ── GetTranscriptSummary ──────────────────────────────────────────────────

    [Fact]
    public void TranscriptSummary_TextOnly_True_WhenTriggerPresent()
    {
        var summary = VoiceWakeRecognitionDebugSupport.GetTranscriptSummary(
            "hey claude do something",
            ["hey claude"]);
        Assert.True(summary.TextOnly);
    }

    [Fact]
    public void TranscriptSummary_TextOnly_False_WhenNoTrigger()
    {
        var summary = VoiceWakeRecognitionDebugSupport.GetTranscriptSummary(
            "unrelated text",
            ["hey claude"]);
        Assert.False(summary.TextOnly);
    }

    [Fact]
    public void TranscriptSummary_TimingCount_Zero_WhenAllSegmentsHaveZeroTiming()
    {
        var segs = new[] { new WakeWordSegment(0, 0), new WakeWordSegment(0, 0) };
        var summary = VoiceWakeRecognitionDebugSupport.GetTranscriptSummary(
            "hey claude", ["hey claude"], segs);
        Assert.Equal(0, summary.TimingCount);
    }

    [Fact]
    public void TranscriptSummary_TimingCount_CountsNonZeroSegments()
    {
        var segs = new[]
        {
            new WakeWordSegment(0, 0),
            new WakeWordSegment(0.5, 0),
            new WakeWordSegment(0, 1.0)
        };
        var summary = VoiceWakeRecognitionDebugSupport.GetTranscriptSummary(
            "hey claude", ["hey claude"], segs);
        Assert.Equal(2, summary.TimingCount);
    }

    // ── MatchSummary ──────────────────────────────────────────────────────────

    [Fact]
    public void MatchSummary_Null_ReturnsMatchFalse()
    {
        Assert.Equal("match=false", VoiceWakeRecognitionDebugSupport.MatchSummary(null));
    }

    [Fact]
    public void MatchSummary_Match_ReturnsFormattedString()
    {
        var match = new WakeWordGateMatch(TriggerEndTime: 0, PostGap: 0.75, Command: "do something");
        var result = VoiceWakeRecognitionDebugSupport.MatchSummary(match);
        Assert.Equal("match=true gap=0.75s cmdLen=12", result);
    }

    [Fact]
    public void MatchSummary_Gap_FormattedToTwoDecimals()
    {
        var match = new WakeWordGateMatch(TriggerEndTime: 0, PostGap: 0.1, Command: "x");
        Assert.Contains("gap=0.10s", VoiceWakeRecognitionDebugSupport.MatchSummary(match));
    }

    // ── Helper ────────────────────────────────────────────────────────────────

    // Simple TrimWake: removes trigger words from start of transcript.
    private static string TrimWake(string transcript, IEnumerable<string> triggers)
    {
        foreach (var t in triggers)
        {
            if (transcript.StartsWith(t, StringComparison.OrdinalIgnoreCase))
                return transcript[t.Length..].TrimStart();
        }
        return transcript;
    }
}
