using OpenClawWindows.Presentation.Helpers;
using Windows.Foundation;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class WindowPlacementTests
{
    // --- CenteredFrame ---

    [Fact]
    public void CenteredFrame_ZeroBounds_ReturnsOriginWithGivenSize()
    {
        // Mirrors Swift: bounds == .zero → NSRect(origin: .zero, size: size)
        var frame = WindowPlacement.CenteredFrame(new Size(120, 80), new Rect(0, 0, 0, 0));
        Assert.Equal(0, frame.X);
        Assert.Equal(0, frame.Y);
        Assert.Equal(120, frame.Width);
        Assert.Equal(80, frame.Height);
    }

    [Fact]
    public void CenteredFrame_ClampsToBoundsAndCenters()
    {
        // bounds = (10, 20, 300, 200); size = (600, 120) → clamped to 300 × 120, centered
        var bounds = new Rect(10, 20, 300, 200);
        var frame = WindowPlacement.CenteredFrame(new Size(600, 120), bounds);
        Assert.Equal(bounds.Width, frame.Width);
        Assert.Equal(120, frame.Height);
        Assert.Equal(bounds.X, frame.X);                         // left edge = bounds.Left (clamped width fills bounds)
        Assert.Equal(bounds.Y + bounds.Height / 2, frame.Y + frame.Height / 2); // midY matches
    }

    [Fact]
    public void CenteredFrame_SmallerThanBounds_IsCentered()
    {
        var bounds = new Rect(0, 0, 400, 300);
        var frame = WindowPlacement.CenteredFrame(new Size(100, 80), bounds);
        Assert.Equal(150, frame.X); // (400-100)/2
        Assert.Equal(110, frame.Y); // (300-80)/2
        Assert.Equal(100, frame.Width);
        Assert.Equal(80, frame.Height);
    }

    // --- TopRightFrame ---

    [Fact]
    public void TopRightFrame_ZeroBounds_ReturnsOriginWithGivenSize()
    {
        // Mirrors Swift: bounds == .zero → NSRect(origin: .zero, size: size)
        var frame = WindowPlacement.TopRightFrame(new Size(120, 80), 12, new Rect(0, 0, 0, 0));
        Assert.Equal(0, frame.X);
        Assert.Equal(0, frame.Y);
        Assert.Equal(120, frame.Width);
        Assert.Equal(80, frame.Height);
    }

    [Fact]
    public void TopRightFrame_ClampsToBoundsAndAppliesPadding()
    {
        // Mirrors macOS test: bounds=(10,20,300,200), size=(400,50), padding=8
        // frame.Right == bounds.Right - 8 (same formula); frame.Top == bounds.Top + 8 (Y-down adaptation)
        var bounds = new Rect(10, 20, 300, 200);
        var frame = WindowPlacement.TopRightFrame(new Size(400, 50), 8, bounds);
        Assert.Equal(bounds.Width, frame.Width);   // clamped
        Assert.Equal(50, frame.Height);
        Assert.Equal(bounds.Right - 8, frame.Right);
        Assert.Equal(bounds.Top + 8, frame.Top);
    }

    [Fact]
    public void TopRightFrame_FitsWithinBounds_NoClamp()
    {
        var bounds = new Rect(0, 0, 500, 400);
        var frame = WindowPlacement.TopRightFrame(new Size(100, 60), 10, bounds);
        // x = round(0 + 500 - 100 - 10) = 390; frame.Right = 390 + 100 = 490 = bounds.Right - padding
        Assert.Equal(490, frame.Right);
        Assert.Equal(10, frame.Top);
        Assert.Equal(100, frame.Width);
        Assert.Equal(60, frame.Height);
    }

    // --- AnchoredBelowFrame ---

    [Fact]
    public void AnchoredBelowFrame_ZeroBounds_PlacesBelowAnchorCentered()
    {
        var anchor = new Rect(100, 50, 40, 20); // bottom = 70
        var frame = WindowPlacement.AnchoredBelowFrame(new Size(80, 30), anchor, 8, new Rect(0, 0, 0, 0));
        // x = round(100 + 40/2 - 80/2) = round(120 - 40) = 80
        Assert.Equal(80, frame.X);
        // y = round(50 + 20 + 8) = 78
        Assert.Equal(78, frame.Y);
        Assert.Equal(80, frame.Width);
        Assert.Equal(30, frame.Height);
    }

    [Fact]
    public void AnchoredBelowFrame_WithinBounds_NoClamping()
    {
        var bounds = new Rect(0, 0, 800, 600);
        var anchor = new Rect(350, 100, 100, 40); // midX=400, bottom=140
        var frame = WindowPlacement.AnchoredBelowFrame(new Size(200, 80), anchor, 5, bounds);
        Assert.Equal(300, frame.X);   // round(400 - 200/2)
        Assert.Equal(145, frame.Y);   // round(140 + 5)
        Assert.Equal(200, frame.Width);
        Assert.Equal(80, frame.Height);
    }

    [Fact]
    public void AnchoredBelowFrame_XClampedToRightEdge()
    {
        // anchor near right edge → clamp X so frame stays inside bounds
        var bounds = new Rect(0, 0, 500, 600);
        var anchor = new Rect(450, 100, 40, 20); // midX=470
        var frame = WindowPlacement.AnchoredBelowFrame(new Size(200, 60), anchor, 0, bounds);
        // desiredX = round(470 - 100) = 370; maxX = 500-200=300 → clamped to 300
        Assert.Equal(300, frame.X);
    }

    [Fact]
    public void AnchoredBelowFrame_YClampedToBottomEdge()
    {
        // anchor near bottom of bounds → clamp Y
        var bounds = new Rect(0, 0, 800, 400);
        var anchor = new Rect(300, 350, 100, 30); // bottom = 380
        var frame = WindowPlacement.AnchoredBelowFrame(new Size(100, 60), anchor, 5, bounds);
        // desiredY = round(380 + 5) = 385; maxY = 400 - 60 = 340 → clamped to 340
        Assert.Equal(340, frame.Y);
    }
}
