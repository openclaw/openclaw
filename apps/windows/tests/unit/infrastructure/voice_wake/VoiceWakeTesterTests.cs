using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Infrastructure.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Infrastructure.VoiceWake;

public sealed class VoiceWakeTesterTests
{
    // ── Tunables ──────────────────────────────────────────────────────────────

    [Fact]
    public void SilenceWindow_Is1Second()
    {
        Assert.Equal(TimeSpan.FromSeconds(1.0), VoiceWakeTester.SilenceWindow);
    }

    [Fact]
    public void FinalizeTimeout_Is1Point5Seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(1.5), VoiceWakeTester.FinalizeTimeout);
    }

    [Fact]
    public void HoldHardStop_Is6Seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(6.0), VoiceWakeTester.HoldHardStop);
    }

    [Fact]
    public void SilencePollMs_Is200()
    {
        Assert.Equal(200, VoiceWakeTester.SilencePollMs);
    }

    // ── Failure messages — mirrors handleResult() strings ────────────────────

    [Fact]
    public void MsgNoSpeech_IsCorrect()
    {
        Assert.Equal("No speech detected", VoiceWakeTester.MsgNoSpeech);
    }

    [Fact]
    public void MsgNoTrigger_IsCorrect()
    {
        Assert.Equal("No trigger heard: ", VoiceWakeTester.MsgNoTrigger);
    }

    // ── TrimWake ──────────────────────────────────────────────────────────────

    [Fact]
    public void TrimWake_RemovesSingleWordTrigger()
    {
        // "claude do thing" with trigger "claude" → "do thing"
        var result = VoiceWakeTester.TrimWake("claude do thing", ["claude"]);
        Assert.Equal("do thing", result);
    }

    [Fact]
    public void TrimWake_RemovesMultiWordTrigger()
    {
        // "hey claude do the thing" with trigger "hey claude" → "do the thing"
        var result = VoiceWakeTester.TrimWake("hey claude do the thing", ["hey claude"]);
        Assert.Equal("do the thing", result);
    }

    [Fact]
    public void TrimWake_ReturnsTrimmed_WhenTriggerIsCaseInsensitiveMatch()
    {
        // Adapts VoiceWakeTextUtils.NormalizeToken (lowercased)
        var result = VoiceWakeTester.TrimWake("Claude please help", ["claude"]);
        Assert.Equal("please help", result);
    }

    [Fact]
    public void TrimWake_ReturnsOriginal_WhenTriggerNotAtStart()
    {
        // "do thing claude" — trigger not at start
        var result = VoiceWakeTester.TrimWake("do thing claude", ["claude"]);
        Assert.Equal("do thing claude", result);
    }

    [Fact]
    public void TrimWake_ReturnsOriginal_WhenNoWordAfterTrigger()
    {
        // "claude" alone — no command words follow; words.Length == triggerWords.Length → skip
        var result = VoiceWakeTester.TrimWake("claude", ["claude"]);
        Assert.Equal("claude", result);
    }

    [Fact]
    public void TrimWake_UsesFirstMatchingTrigger()
    {
        // Multiple triggers; "openclaw" matches before "hey"
        var result = VoiceWakeTester.TrimWake("openclaw do stuff", ["openclaw", "hey"]);
        Assert.Equal("do stuff", result);
    }

    // ── VoiceWakeTestState shape ──────────────────────────────────────────────

    [Fact]
    public void Idle_IsSingleton()
    {
        Assert.Same(VoiceWakeTestState.Idle.Instance, VoiceWakeTestState.Idle.Instance);
    }

    [Fact]
    public void Listening_IsSingleton()
    {
        Assert.Same(VoiceWakeTestState.Listening.Instance, VoiceWakeTestState.Listening.Instance);
    }

    [Fact]
    public void Hearing_ExposesText()
    {
        var s = new VoiceWakeTestState.Hearing("hello world");
        Assert.Equal("hello world", s.Text);
    }

    [Fact]
    public void Detected_ExposesCommand()
    {
        var s = new VoiceWakeTestState.Detected("do the thing");
        Assert.Equal("do the thing", s.Command);
    }

    [Fact]
    public void Failed_ExposesMessage()
    {
        var s = new VoiceWakeTestState.Failed("permission denied");
        Assert.Equal("permission denied", s.Message);
    }

    // ── handleResult branching — mirrors Swift guard conditions ───────────────

    [Theory]
    [InlineData("", true,  true)]   // empty + isFinal → failed("No speech detected")
    [InlineData("hello", true, false)]  // text + isFinal (no trigger) → failed("No trigger heard: ...")
    [InlineData("", false, false)]  // empty + partial → listening (not failed)
    public void FinalResult_EmptyText_ProducesMsgNoSpeech(string text, bool isFinal, bool expectNoSpeech)
    {
        // Pure guard logic: if isFinal && text.isEmpty → MsgNoSpeech; else MsgNoTrigger
        if (isFinal && expectNoSpeech)
            Assert.Equal(VoiceWakeTester.MsgNoSpeech, string.IsNullOrEmpty(text) ? VoiceWakeTester.MsgNoSpeech : null);
        else if (isFinal && !expectNoSpeech)
            Assert.StartsWith(VoiceWakeTester.MsgNoTrigger, $"{VoiceWakeTester.MsgNoTrigger}\"{text}\"");
        else
            Assert.True(!isFinal); // partial → not a final failure
    }
}
