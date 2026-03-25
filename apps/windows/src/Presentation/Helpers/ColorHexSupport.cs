using Windows.UI;

namespace OpenClawWindows.Presentation.Helpers;

internal static class ColorHexSupport
{
    internal static Color? ColorFromHex(string? raw)
    {
        var trimmed = (raw ?? "").Trim();
        if (trimmed.Length == 0) return null;

        var hex = trimmed.StartsWith('#') ? trimmed[1..] : trimmed;
        if (hex.Length != 6) return null;
        if (!int.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var value))
            return null;

        return Color.FromArgb(
            255,
            (byte)((value >> 16) & 0xFF),
            (byte)((value >> 8) & 0xFF),
            (byte)(value & 0xFF));
    }
}
