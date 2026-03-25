namespace OpenClawWindows.Application.VoiceWake;

internal static class VoiceWakeHelpers
{
    // Tunables
    internal const int    MaxWords      = 32;       // voiceWakeMaxWords
    internal const int    MaxWordLength = 64;       // voiceWakeMaxWordLength
    internal static readonly IReadOnlyList<string> DefaultTriggers = ["openclaw"]; // defaultVoiceWakeTriggers

    internal static IReadOnlyList<string> SanitizeTriggers(IEnumerable<string> words)
    {
        var cleaned = words
            .Select(w => w.Trim())
            .Where(w => w.Length > 0)
            .Take(MaxWords)
            .Select(w => w.Length > MaxWordLength ? w[..MaxWordLength] : w)
            .ToList();

        return cleaned.Count == 0 ? DefaultTriggers : cleaned;
    }

    internal static string NormalizeLocaleIdentifier(string raw)
    {
        var s = raw;

        var at = s.IndexOf('@');
        if (at >= 0) s = s[..at];

        var u = s.IndexOf("-u-", StringComparison.Ordinal);
        if (u >= 0) s = s[..u];

        var t = s.IndexOf("-t-", StringComparison.Ordinal);
        if (t >= 0) s = s[..t];

        return s;
    }
}
