using Windows.UI;

namespace OpenClawWindows.Presentation.Tray.Components;

// Color values; callers wrap in SolidColorBrush.
// At namespace level to avoid shadowing outer members (S3218).
internal readonly record struct MenuItemHighlightPalette(Color Primary, Color Secondary);

// Returns Windows.UI.Color (pure value type, no WinRT host needed) instead of SolidColorBrush;
// callers create brushes. Adapts:
//   NSColor.selectedMenuItemTextColor → Colors.White
//   SwiftUI .primary  → opaque black (light-mode tray menu default)
//   SwiftUI .secondary → ~60% black / 85% white
internal static class MenuItemHighlightColors
{
    // Tunables
    internal const byte HighlightedSecondaryAlpha = 0xD9;  // 0.85 × 255 ≈ 217
    internal const byte NormalSecondaryAlpha       = 0x99;  // ≈ 60% opacity

    // ── Primary ───────────────────────────────────────────────────────────────

    // highlighted: selectedMenuItemTextColor; normal: .primary
    internal static Color Primary(bool highlighted) =>
        highlighted
            ? Color.FromArgb(0xFF, 0xFF, 0xFF, 0xFF)  // selectedMenuItemTextColor (white)
            : Color.FromArgb(0xFF, 0x00, 0x00, 0x00); // .primary (light-mode label = black)

    // ── Secondary ─────────────────────────────────────────────────────────────

    // highlighted: selectedMenuItemTextColor.opacity(0.85)
    internal static Color Secondary(bool highlighted) =>
        highlighted
            ? Color.FromArgb(HighlightedSecondaryAlpha, 0xFF, 0xFF, 0xFF)
            : Color.FromArgb(NormalSecondaryAlpha,       0x00, 0x00, 0x00);

    // ── Palette ───────────────────────────────────────────────────────────────

    internal static MenuItemHighlightPalette GetPalette(bool highlighted) =>
        new(Primary(highlighted), Secondary(highlighted));
}
