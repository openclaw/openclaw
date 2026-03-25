using Windows.Foundation;
using Windows.Graphics;

namespace OpenClawWindows.Presentation.Helpers;

/// <summary>Geometry helpers for positioning and validating window frames on-screen.</summary>
// Windows uses Y-down, so TopRightFrame and AnchoredBelowFrame invert the Y formula.
internal static class WindowPlacement
{
    internal static Rect CenteredFrame(Size size, DisplayArea? screen = null)
    {
        var bounds = WorkArea(screen ?? DisplayArea.Primary);
        return CenteredFrame(size, bounds);
    }

    internal static Rect CenteredFrame(Size size, Rect bounds)
    {
        if (IsZero(bounds))
            return new Rect(0, 0, size.Width, size.Height);

        var w = Math.Min(size.Width, bounds.Width);
        var h = Math.Min(size.Height, bounds.Height);
        var x = Math.Round(bounds.X + (bounds.Width - w) / 2);
        var y = Math.Round(bounds.Y + (bounds.Height - h) / 2);
        return new Rect(x, y, w, h);
    }

    internal static Rect TopRightFrame(Size size, double padding, DisplayArea? screen = null)
    {
        var bounds = WorkArea(screen ?? DisplayArea.Primary);
        return TopRightFrame(size, padding, bounds);
    }

    internal static Rect TopRightFrame(Size size, double padding, Rect bounds)
    {
        if (IsZero(bounds))
            return new Rect(0, 0, size.Width, size.Height);

        var w = Math.Min(size.Width, bounds.Width);
        var h = Math.Min(size.Height, bounds.Height);
        var x = Math.Round(bounds.X + bounds.Width - w - padding);
        var y = Math.Round(bounds.Y + padding);
        return new Rect(x, y, w, h);
    }

    internal static Rect AnchoredBelowFrame(Size size, Rect anchor, double padding, Rect bounds)
    {
        // Windows "below" = anchor.Bottom + padding (Y-down).
        if (IsZero(bounds))
        {
            var x0 = Math.Round(anchor.X + anchor.Width / 2 - size.Width / 2);
            var y0 = Math.Round(anchor.Y + anchor.Height + padding);
            return new Rect(x0, y0, size.Width, size.Height);
        }

        var w = Math.Min(size.Width, bounds.Width);
        var h = Math.Min(size.Height, bounds.Height);

        var desiredX = Math.Round(anchor.X + anchor.Width / 2 - w / 2);
        var desiredY = Math.Round(anchor.Y + anchor.Height + padding);

        var maxX = bounds.X + bounds.Width - w;
        var maxY = bounds.Y + bounds.Height - h;

        var fx = maxX >= bounds.X ? Math.Min(Math.Max(desiredX, bounds.X), maxX) : bounds.X;
        var fy = maxY >= bounds.Y ? Math.Min(Math.Max(desiredY, bounds.Y), maxY) : bounds.Y;

        return new Rect(fx, fy, w, h);
    }

    internal static void EnsureOnScreen(AppWindow window, Size defaultSize, Func<DisplayArea?, Rect>? fallback = null)
    {
        var pos = window.Position;
        var sz = window.Size;
        var frame = new Rect(pos.X, pos.Y, sz.Width, sz.Height);

        var visibleSomewhere = false;
        foreach (var d in DisplayArea.FindAll())
        {
            var wa = d.WorkArea;
            var inset = new Rect(wa.X + 12, wa.Y + 12, Math.Max(0, wa.Width - 24), Math.Max(0, wa.Height - 24));
            if (Intersects(frame, inset)) { visibleSomewhere = true; break; }
        }

        if (visibleSomewhere) return;

        var screen = DisplayArea.Primary;
        var next = fallback?.Invoke(screen) ?? CenteredFrame(defaultSize, screen);
        window.MoveAndResize(new RectInt32((int)next.X, (int)next.Y, (int)next.Width, (int)next.Height));
    }

    private static Rect WorkArea(DisplayArea display)
    {
        var wa = display.WorkArea;
        return new Rect(wa.X, wa.Y, wa.Width, wa.Height);
    }

    private static bool IsZero(Rect r) => r.Width == 0 && r.Height == 0;

    private static bool Intersects(Rect a, Rect b) =>
        a.Left < b.Right && a.Right > b.Left && a.Top < b.Bottom && a.Bottom > b.Top;
}
