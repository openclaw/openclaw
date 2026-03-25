using Microsoft.UI.Xaml;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Presentation.Settings;

namespace OpenClawWindows.Tests.Unit.Presentation;

// Mirrors VoiceWakeTestCard.swift static computed properties — pure logic tests.
public sealed class VoiceWakeTestCardTests
{
    // ── StatusText ────────────────────────────────────────────────────────────

    [Fact]
    public void StatusText_Idle_ReturnsInstructions()
    {
        var text = VoiceWakeTestCard.StatusText(VoiceWakeTestState.Idle.Instance);
        Assert.Contains("Press Start", text);
    }

    [Fact]
    public void StatusText_Listening_ReturnsListeningMessage()
    {
        var text = VoiceWakeTestCard.StatusText(VoiceWakeTestState.Listening.Instance);
        Assert.Contains("Listening", text);
    }

    [Fact]
    public void StatusText_Hearing_IncludesTranscript()
    {
        var text = VoiceWakeTestCard.StatusText(new VoiceWakeTestState.Hearing("hey claude"));
        Assert.Contains("hey claude", text);
    }

    [Fact]
    public void StatusText_Finalizing_ReturnsFinalizing()
    {
        var text = VoiceWakeTestCard.StatusText(VoiceWakeTestState.Finalizing.Instance);
        Assert.Contains("Finalizing", text);
    }

    [Fact]
    public void StatusText_Detected_ReturnsDetectedMessage()
    {
        var text = VoiceWakeTestCard.StatusText(new VoiceWakeTestState.Detected("run this"));
        Assert.Contains("detected", text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void StatusText_Failed_ReturnsFailureMessage()
    {
        var text = VoiceWakeTestCard.StatusText(new VoiceWakeTestState.Failed("mic denied"));
        Assert.Equal("mic denied", text);
    }

    // ── HeardSubText ──────────────────────────────────────────────────────────

    [Fact]
    public void HeardSubText_Detected_ReturnsHeardPrefix()
    {
        // Mirrors Swift: if case let .detected(text) = testState { Text("Heard: \(text)") }
        var sub = VoiceWakeTestCard.HeardSubText(new VoiceWakeTestState.Detected("run this"));
        Assert.NotNull(sub);
        Assert.Contains("run this", sub!);
    }

    [Fact]
    public void HeardSubText_OtherStates_ReturnsNull()
    {
        Assert.Null(VoiceWakeTestCard.HeardSubText(VoiceWakeTestState.Idle.Instance));
        Assert.Null(VoiceWakeTestCard.HeardSubText(VoiceWakeTestState.Listening.Instance));
        Assert.Null(VoiceWakeTestCard.HeardSubText(new VoiceWakeTestState.Hearing("partial")));
        Assert.Null(VoiceWakeTestCard.HeardSubText(new VoiceWakeTestState.Failed("err")));
    }

    // ── Spinner visibility ────────────────────────────────────────────────────

    [Fact]
    public void SpinnerVisibility_Finalizing_IsVisible()
    {
        Assert.Equal(Visibility.Visible, VoiceWakeTestCard.SpinnerVisibility(VoiceWakeTestState.Finalizing.Instance));
    }

    [Theory]
    [InlineData(nameof(VoiceWakeTestState.Idle))]
    [InlineData(nameof(VoiceWakeTestState.Listening))]
    public void SpinnerVisibility_NonFinalizing_IsCollapsed(string caseName)
    {
        var state = caseName switch
        {
            nameof(VoiceWakeTestState.Idle)      => (VoiceWakeTestState)VoiceWakeTestState.Idle.Instance,
            nameof(VoiceWakeTestState.Listening) => VoiceWakeTestState.Listening.Instance,
            _                                    => VoiceWakeTestState.Idle.Instance,
        };
        Assert.Equal(Visibility.Collapsed, VoiceWakeTestCard.SpinnerVisibility(state));
    }

    // ── Icon visibility is inverse of spinner ─────────────────────────────────

    [Fact]
    public void IconVisibility_Finalizing_IsCollapsed()
    {
        Assert.Equal(Visibility.Collapsed, VoiceWakeTestCard.IconVisibility(VoiceWakeTestState.Finalizing.Instance));
    }

    [Fact]
    public void IconVisibility_Idle_IsVisible()
    {
        Assert.Equal(Visibility.Visible, VoiceWakeTestCard.IconVisibility(VoiceWakeTestState.Idle.Instance));
    }

    // ── Glyph changes per state ───────────────────────────────────────────────

    [Fact]
    public void StatusGlyph_Detected_DiffersFromIdle()
    {
        var idle     = VoiceWakeTestCard.StatusGlyph(VoiceWakeTestState.Idle.Instance);
        var detected = VoiceWakeTestCard.StatusGlyph(new VoiceWakeTestState.Detected("ok"));
        Assert.NotEqual(idle, detected);
    }

    [Fact]
    public void StatusGlyph_Failed_DiffersFromIdle()
    {
        var idle   = VoiceWakeTestCard.StatusGlyph(VoiceWakeTestState.Idle.Instance);
        var failed = VoiceWakeTestCard.StatusGlyph(new VoiceWakeTestState.Failed("err"));
        Assert.NotEqual(idle, failed);
    }
}
