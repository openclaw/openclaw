namespace OpenClawWindows.Presentation.Formatters;

internal static class DurationFormatter
{
    internal static string ConciseDuration(int ms)
    {
        if (ms < 1000) return $"{ms}ms";
        var s = ms / 1000.0;
        if (s < 60) return $"{(int)Math.Round(s, MidpointRounding.AwayFromZero)}s";
        var m = s / 60.0;
        if (m < 60) return $"{(int)Math.Round(m, MidpointRounding.AwayFromZero)}m";
        var h = m / 60.0;
        if (h < 48) return $"{(int)Math.Round(h, MidpointRounding.AwayFromZero)}h";
        var d = h / 24.0;
        return $"{(int)Math.Round(d, MidpointRounding.AwayFromZero)}d";
    }
}
