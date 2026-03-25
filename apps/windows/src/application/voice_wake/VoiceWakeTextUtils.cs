namespace OpenClawWindows.Application.VoiceWake;

internal static class VoiceWakeTextUtils
{
    internal delegate string TrimWake(string transcript, IEnumerable<string> triggers);

    internal static string NormalizeToken(string token)
    {
        var span = token.AsSpan();
        while (span.Length > 0 && (char.IsWhiteSpace(span[0]) || char.IsPunctuation(span[0])))
            span = span[1..];
        while (span.Length > 0 && (char.IsWhiteSpace(span[^1]) || char.IsPunctuation(span[^1])))
            span = span[..^1];
        return span.ToString().ToLowerInvariant();
    }

    internal static bool StartsWithTrigger(string transcript, IEnumerable<string> triggers)
    {
        var tokens = transcript
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Select(NormalizeToken)
            .Where(t => t.Length > 0)
            .ToList();

        if (tokens.Count == 0) return false;

        foreach (var trigger in triggers)
        {
            var triggerTokens = trigger
                .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                .Select(NormalizeToken)
                .Where(t => t.Length > 0)
                .ToList();

            if (triggerTokens.Count == 0 || tokens.Count < triggerTokens.Count) continue;

            if (triggerTokens.Zip(tokens.Take(triggerTokens.Count)).All(p => p.First == p.Second))
                return true;
        }

        return false;
    }

    internal static string? TextOnlyCommand(
        string transcript,
        IEnumerable<string> triggers,
        int minCommandLength,
        TrimWake trimWake,
        Func<string, IEnumerable<string>, bool>? matchesTextOnly = null)
    {
        if (transcript.Length == 0) return null;
        if (NormalizeToken(transcript).Length == 0) return null;

        // Injected delegate; defaults to normalized contains-any check as text-only pre-filter.
        var gate = matchesTextOnly ?? DefaultMatchesTextOnly;
        if (!gate(transcript, triggers)) return null;

        if (!StartsWithTrigger(transcript, triggers)) return null;

        var trimmed = trimWake(transcript, triggers);
        if (trimmed.Length < minCommandLength) return null;

        return trimmed;
    }

    // Default text-only gate: transcript must contain at least one trigger word.
    private static bool DefaultMatchesTextOnly(string text, IEnumerable<string> triggers) =>
        triggers.Any(t => text.Contains(t, StringComparison.OrdinalIgnoreCase));
}
