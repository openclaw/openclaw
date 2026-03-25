using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.VoiceWake;

namespace OpenClawWindows.Presentation.Voice;

// defined here because SwabbleKit is not
// available on Windows. Used only by VoiceWakeRecognitionDebugSupport.
internal sealed record WakeWordGateMatch(double TriggerEndTime, double PostGap, string Command);

internal sealed record WakeWordGateConfig(int MinCommandLength);

// timing info not available on Windows;
// Start and Duration are always 0 here, so TimingCount is always 0.
internal sealed record WakeWordSegment(double Start, double Duration);

internal static class VoiceWakeRecognitionDebugSupport
{
    internal readonly record struct TranscriptSummary(bool TextOnly, int TimingCount);

    // Tunables
    internal static readonly TimeSpan DefaultMinRepeatInterval = TimeSpan.FromSeconds(0.25);

    internal static bool ShouldLogTranscript(
        string transcript,
        bool isFinal,
        LogLevel loggerLevel,
        ref string? lastLoggedText,
        ref DateTimeOffset? lastLoggedAt,
        TimeSpan minRepeatInterval = default)
    {
        if (transcript.Length == 0) return false;

        if (loggerLevel != LogLevel.Debug && loggerLevel != LogLevel.Trace) return false;

        var interval = minRepeatInterval == default ? DefaultMinRepeatInterval : minRepeatInterval;
        if (transcript == lastLoggedText &&
            !isFinal &&
            lastLoggedAt.HasValue &&
            (DateTimeOffset.UtcNow - lastLoggedAt.Value) < interval)
        {
            return false;
        }

        lastLoggedText = transcript;
        lastLoggedAt   = DateTimeOffset.UtcNow;
        return true;
    }

    // Returns WakeWordGateMatch(triggerEndTime: 0, postGap: 0, command: command) or null.
    internal static WakeWordGateMatch? TextOnlyFallbackMatch(
        string transcript,
        IEnumerable<string> triggers,
        WakeWordGateConfig config,
        VoiceWakeTextUtils.TrimWake trimWake,
        Func<string, IEnumerable<string>, bool>? matchesTextOnly = null)
    {
        var command = VoiceWakeTextUtils.TextOnlyCommand(
            transcript,
            triggers,
            config.MinCommandLength,
            trimWake,
            matchesTextOnly);

        if (command is null) return null;
        return new WakeWordGateMatch(TriggerEndTime: 0, PostGap: 0, Command: command);
    }

    internal static TranscriptSummary GetTranscriptSummary(
        string transcript,
        IEnumerable<string> triggers,
        IEnumerable<WakeWordSegment>? segments = null,
        Func<string, IEnumerable<string>, bool>? matchesTextOnly = null)
    {
        var gate = matchesTextOnly ?? DefaultMatchesTextOnly;
        var textOnly = gate(transcript, triggers);

        var timingCount = segments?.Count(s => s.Start > 0 || s.Duration > 0) ?? 0;

        return new TranscriptSummary(TextOnly: textOnly, TimingCount: timingCount);
    }

    // "match=true gap=X.XXs cmdLen=N" or "match=false".
    internal static string MatchSummary(WakeWordGateMatch? match) =>
        match is not null
            // Mirror Swift: String(format: "%.2f", $0.postGap) — always uses invariant decimal point.
            ? $"match=true gap={match.PostGap.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}s cmdLen={match.Command.Length}"
            : "match=false";

    // Default text-only gate — same logic as VoiceWakeTextUtils.DefaultMatchesTextOnly.
    private static bool DefaultMatchesTextOnly(string text, IEnumerable<string> triggers) =>
        triggers.Any(t => text.Contains(t, StringComparison.OrdinalIgnoreCase));
}
