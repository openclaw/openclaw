using System.Text.Json;

namespace OpenClawWindows.Domain.TalkMode;

// Controls per-response ElevenLabs voice/model overrides embedded on the first JSON line.

internal sealed record TalkDirective(
    string? VoiceId,
    string? ModelId,
    double? Speed,
    int? RateWpm,
    double? Stability,
    double? Similarity,
    double? Style,
    bool? SpeakerBoost,
    int? Seed,
    string? Normalize,
    string? Language,
    string? OutputFormat,
    int? LatencyTier,
    bool? Once);

internal sealed record TalkDirectiveParseResult(
    TalkDirective? Directive,
    string Stripped,
    IReadOnlyList<string> UnknownKeys);

internal static class TalkDirectiveParser
{
    // Parses an optional JSON directive from the first non-empty line of the assistant response.
    internal static TalkDirectiveParseResult Parse(string text)
    {
        var normalized = text.Replace("\r\n", "\n");
        var lines = normalized.Split('\n');

        var firstIdx = Array.FindIndex(lines, l => !string.IsNullOrWhiteSpace(l));
        if (firstIdx < 0)
            return new TalkDirectiveParseResult(null, text, Array.Empty<string>());

        if (firstIdx > 0)
            lines = lines[firstIdx..];

        var head = lines[0].Trim();
        if (!head.StartsWith('{') || !head.EndsWith('}'))
            return new TalkDirectiveParseResult(null, text, Array.Empty<string>());

        Dictionary<string, JsonElement>? json;
        try
        {
            json = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(head);
        }
        catch
        {
            return new TalkDirectiveParseResult(null, text, Array.Empty<string>());
        }
        if (json == null) return new TalkDirectiveParseResult(null, text, Array.Empty<string>());

        var speakerBoost = BoolValue(json, ["speaker_boost", "speakerBoost"]);
        if (speakerBoost == null)
        {
            var noBoost = BoolValue(json, ["no_speaker_boost", "noSpeakerBoost"]);
            if (noBoost.HasValue) speakerBoost = !noBoost.Value;
        }

        var directive = new TalkDirective(
            VoiceId: StringValue(json, ["voice", "voice_id", "voiceId"]),
            ModelId: StringValue(json, ["model", "model_id", "modelId"]),
            Speed: DoubleValue(json, ["speed"]),
            RateWpm: IntValue(json, ["rate", "wpm"]),
            Stability: DoubleValue(json, ["stability"]),
            Similarity: DoubleValue(json, ["similarity", "similarity_boost", "similarityBoost"]),
            Style: DoubleValue(json, ["style"]),
            SpeakerBoost: speakerBoost,
            Seed: IntValue(json, ["seed"]),
            Normalize: StringValue(json, ["normalize", "apply_text_normalization"]),
            Language: StringValue(json, ["lang", "language_code", "language"]),
            OutputFormat: StringValue(json, ["output_format", "format"]),
            LatencyTier: IntValue(json, ["latency", "latency_tier", "latencyTier"]),
            Once: BoolValue(json, ["once"]));

        // If no recognized directive fields, treat first line as plain text.
        bool hasDirective =
            directive.VoiceId != null || directive.ModelId != null ||
            directive.Speed != null || directive.RateWpm != null ||
            directive.Stability != null || directive.Similarity != null ||
            directive.Style != null || directive.SpeakerBoost != null ||
            directive.Seed != null || directive.Normalize != null ||
            directive.Language != null || directive.OutputFormat != null ||
            directive.LatencyTier != null || directive.Once != null;

        if (!hasDirective)
            return new TalkDirectiveParseResult(null, text, Array.Empty<string>());

        HashSet<string> known = [
            "voice", "voice_id", "voiceid",
            "model", "model_id", "modelid",
            "speed", "rate", "wpm",
            "stability", "similarity", "similarity_boost", "similarityboost",
            "style",
            "speaker_boost", "speakerboost",
            "no_speaker_boost", "nospeakerboost",
            "seed",
            "normalize", "apply_text_normalization",
            "lang", "language_code", "language",
            "output_format", "format",
            "latency", "latency_tier", "latencytier",
            "once",
        ];
        var unknown = json.Keys.Where(k => !known.Contains(k.ToLowerInvariant())).OrderBy(k => k).ToList();

        // Strip directive line (and the blank line that follows it, if present).
        var remaining = lines[1..].ToList();
        if (remaining.Count > 0 && string.IsNullOrWhiteSpace(remaining[0]))
            remaining.RemoveAt(0);
        var stripped = string.Join("\n", remaining);

        return new TalkDirectiveParseResult(directive, stripped, unknown);
    }

    private static string? StringValue(Dictionary<string, JsonElement> d, string[] keys)
    {
        foreach (var k in keys)
        {
            if (d.TryGetValue(k, out var el) && el.ValueKind == JsonValueKind.String)
            {
                var v = el.GetString()?.Trim();
                if (!string.IsNullOrEmpty(v)) return v;
            }
        }
        return null;
    }

    private static double? DoubleValue(Dictionary<string, JsonElement> d, string[] keys)
    {
        foreach (var k in keys)
        {
            if (!d.TryGetValue(k, out var el)) continue;
            if (el.ValueKind == JsonValueKind.Number) return el.GetDouble();
            if (el.ValueKind == JsonValueKind.String && double.TryParse(el.GetString(), out var dv)) return dv;
        }
        return null;
    }

    private static int? IntValue(Dictionary<string, JsonElement> d, string[] keys)
    {
        foreach (var k in keys)
        {
            if (!d.TryGetValue(k, out var el)) continue;
            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var iv)) return iv;
            if (el.ValueKind == JsonValueKind.Number) return (int)el.GetDouble();
            if (el.ValueKind == JsonValueKind.String && int.TryParse(el.GetString(), out var sv)) return sv;
        }
        return null;
    }

    private static bool? BoolValue(Dictionary<string, JsonElement> d, string[] keys)
    {
        foreach (var k in keys)
        {
            if (!d.TryGetValue(k, out var el)) continue;
            if (el.ValueKind == JsonValueKind.True) return true;
            if (el.ValueKind == JsonValueKind.False) return false;
            if (el.ValueKind == JsonValueKind.String)
            {
                var s = el.GetString()?.Trim().ToLowerInvariant();
                if (s is "true" or "yes" or "1") return true;
                if (s is "false" or "no" or "0") return false;
            }
        }
        return null;
    }
}
