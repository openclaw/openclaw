using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Presentation.Voice;
using Windows.Graphics;

namespace OpenClawWindows.Tests.Unit.Presentation;

// Mirrors VoiceWakeOverlayController+Window tests — headless (queue=null) frame and lifecycle tests.
public sealed class VoiceOverlayWindowControllerTests
{
    private static VoiceOverlayWindowController MakeController()
        => new(queue: null, NullLogger<VoiceOverlayWindowController>.Instance);

    // ── MeasuredHeight ────────────────────────────────────────────────────────

    [Fact]
    public void MeasuredHeight_EmptyText_ReturnsMinHeight()
    {
        var result = VoiceOverlayWindowController.MeasuredHeight(string.Empty);
        Assert.Equal(VoiceOverlayWindowController.MinHeight, result);
    }

    [Fact]
    public void MeasuredHeight_ShortText_ClampedToMinHeight()
    {
        // A few chars fit in one line; total stays below MinHeight without clamping.
        var result = VoiceOverlayWindowController.MeasuredHeight("hi");
        Assert.Equal(VoiceOverlayWindowController.MinHeight, result);
    }

    [Fact]
    public void MeasuredHeight_VeryLongText_ClampedToMaxHeight()
    {
        var longText = new string('x', 10_000);
        var result   = VoiceOverlayWindowController.MeasuredHeight(longText);
        Assert.Equal(VoiceOverlayWindowController.MaxHeight, result);
    }

    [Fact]
    public void MeasuredHeight_ResultWithinBounds()
    {
        var text   = "Hello, this is a moderately long transcript that spans a couple of lines.";
        var result = VoiceOverlayWindowController.MeasuredHeight(text);
        Assert.InRange(result, VoiceOverlayWindowController.MinHeight, VoiceOverlayWindowController.MaxHeight);
    }

    // ── DismissTargetFrame ────────────────────────────────────────────────────

    [Fact]
    public void DismissTargetFrame_Empty_ScalesDown()
    {
        var frame  = new RectInt32(100, 200, 460, 80);
        var result = VoiceOverlayWindowController.DismissTargetFrame(
            frame, VoiceDismissReason.Empty, VoiceSendOutcome.Empty);

        Assert.NotNull(result);
        // Scaled 0.95 → smaller than original
        Assert.True(result!.Value.Width  < frame.Width);
        Assert.True(result!.Value.Height < frame.Height);
        // Centered: X and Y move inward
        Assert.True(result!.Value.X > frame.X);
        Assert.True(result!.Value.Y > frame.Y);
    }

    [Fact]
    public void DismissTargetFrame_ExplicitSent_ShiftsByConstants()
    {
        var frame  = new RectInt32(100, 200, 460, 80);
        var result = VoiceOverlayWindowController.DismissTargetFrame(
            frame, VoiceDismissReason.Explicit, VoiceSendOutcome.Sent);

        Assert.NotNull(result);
        Assert.Equal(frame.X + 8, result!.Value.X);  // DismissShiftX = 8
        Assert.Equal(frame.Y + 6, result!.Value.Y);  // DismissShiftY = 6
        Assert.Equal(frame.Width,  result!.Value.Width);
        Assert.Equal(frame.Height, result!.Value.Height);
    }

    [Fact]
    public void DismissTargetFrame_ExplicitEmpty_ReturnsCurrentFrame()
    {
        var frame  = new RectInt32(100, 200, 460, 80);
        var result = VoiceOverlayWindowController.DismissTargetFrame(
            frame, VoiceDismissReason.Explicit, VoiceSendOutcome.Empty);

        Assert.NotNull(result);
        Assert.Equal(frame.X,      result!.Value.X);
        Assert.Equal(frame.Y,      result!.Value.Y);
        Assert.Equal(frame.Width,  result!.Value.Width);
        Assert.Equal(frame.Height, result!.Value.Height);
    }

    // ── Constants — exact parity with Swift ───────────────────────────────────

    [Theory]
    [InlineData(nameof(VoiceOverlayWindowController.Width),          440)]
    [InlineData(nameof(VoiceOverlayWindowController.Padding),        10)]
    [InlineData(nameof(VoiceOverlayWindowController.ButtonWidth),    36)]
    [InlineData(nameof(VoiceOverlayWindowController.Spacing),        8)]
    [InlineData(nameof(VoiceOverlayWindowController.VerticalPadding), 8)]
    [InlineData(nameof(VoiceOverlayWindowController.MaxHeight),      400)]
    [InlineData(nameof(VoiceOverlayWindowController.MinHeight),      48)]
    [InlineData(nameof(VoiceOverlayWindowController.CloseOverflow),  10)]
    public void Constants_HaveSwiftParityValues(string name, int expected)
    {
        var prop = typeof(VoiceOverlayWindowController).GetField(name,
            System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Assert.NotNull(prop);
        Assert.Equal(expected, (int)prop!.GetValue(null)!);
    }

    // ── Headless lifecycle ────────────────────────────────────────────────────

    [Fact]
    public void IsVisible_InitiallyFalse()
    {
        var sut = MakeController();
        Assert.False(sut.IsVisible);
    }

    [Fact]
    public void Dismiss_Headless_NotVisible_FiresCallbackImmediately()
    {
        var sut      = MakeController();
        var fired    = false;
        // Dismiss when not visible (queue is null) — onDismissed still fires.
        sut.Dismiss(VoiceDismissReason.Explicit, VoiceSendOutcome.Empty, () => fired = true);
        Assert.True(fired);
        Assert.False(sut.IsVisible);
    }
}
