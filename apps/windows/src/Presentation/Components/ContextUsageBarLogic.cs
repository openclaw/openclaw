using Windows.UI;

namespace OpenClawWindows.Presentation.Components;

/// <summary>
/// Pure computation logic for ContextUsageBar — separated so tests can run without a WinRT host.
/// </summary>
internal static class ContextUsageBarLogic
{
    // Tunables
    internal const double FillWidthMinimum = 1;

    // Track fill alpha
    internal const byte TrackFillAlphaDark  = 36;  // 0.14 * 255 ≈ 36
    internal const byte TrackFillAlphaLight = 31;  // 0.12 * 255 ≈ 31

    // Track stroke alpha
    internal const byte TrackStrokeAlphaDark  = 56; // 0.22 * 255 ≈ 56
    internal const byte TrackStrokeAlphaLight = 51; // 0.20 * 255 ≈ 51

    // Tint thresholds
    internal const int TintThresholdRed    = 95;
    internal const int TintThresholdOrange = 80;
    internal const int TintThresholdYellow = 60;

    // Tint colors
    internal static readonly Color TintRed        = Color.FromArgb(255, 255,  59,  48);
    internal static readonly Color TintOrange     = Color.FromArgb(255, 255, 149,   0);
    internal static readonly Color TintYellow     = Color.FromArgb(255, 255, 214,  10); // #FFD60A
    internal static readonly Color TintGreenDark  = Color.FromArgb(255,  52, 199,  89); // systemGreen (dark)
    internal static readonly Color TintGreenLight = Color.FromArgb(255,  40, 151,  68);
    internal static readonly Color TintSecondary  = Color.FromArgb(140, 128, 128, 128); // .secondary equivalent

    internal static double ComputeFraction(int usedTokens, int contextTokens)
    {
        if (contextTokens <= 0) return 0;
        return Math.Min(1.0, Math.Max(0.0, (double)usedTokens / contextTokens));
    }

    internal static int? ComputePercentUsed(int usedTokens, int contextTokens)
    {
        if (contextTokens <= 0 || usedTokens <= 0) return null;
        return Math.Min(100, (int)Math.Round(ComputeFraction(usedTokens, contextTokens) * 100));
    }

    internal static Color ComputeTintColor(int? percentUsed, bool isDark)
    {
        if (percentUsed is null)                return TintSecondary;
        if (percentUsed >= TintThresholdRed)    return TintRed;
        if (percentUsed >= TintThresholdOrange) return TintOrange;
        if (percentUsed >= TintThresholdYellow) return TintYellow;
        return isDark ? TintGreenDark : TintGreenLight;
    }

    internal static double ComputeFillWidth(double totalWidth, double fraction) =>
        Math.Max(FillWidthMinimum, Math.Floor(totalWidth * fraction));

    internal static string ComputeAccessibilityValue(int usedTokens, int contextTokens)
    {
        if (contextTokens <= 0) return "Unknown context window";
        return $"{(int)Math.Round(ComputeFraction(usedTokens, contextTokens) * 100)} percent used";
    }
}
