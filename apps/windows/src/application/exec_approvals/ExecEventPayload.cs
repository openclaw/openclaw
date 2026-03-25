using System.Text.Json.Serialization;

namespace OpenClawWindows.Application.ExecApprovals;

// sent via INodeRuntimeContext.EmitExecEvent to the gateway node socket.
public sealed record ExecEventPayload
{
    [JsonPropertyName("sessionKey")]
    public string SessionKey { get; init; } = "";

    [JsonPropertyName("runId")]
    public string RunId { get; init; } = "";

    [JsonPropertyName("host")]
    public string Host { get; init; } = "";

    [JsonPropertyName("command")]
    public string? Command { get; init; }

    [JsonPropertyName("exitCode")]
    public int? ExitCode { get; init; }

    [JsonPropertyName("timedOut")]
    public bool? TimedOut { get; init; }

    [JsonPropertyName("success")]
    public bool? Success { get; init; }

    [JsonPropertyName("output")]
    public string? Output { get; init; }

    [JsonPropertyName("reason")]
    public string? Reason { get; init; }

    internal static string? TruncateOutput(string raw, int maxChars = 20_000)
    {
        var trimmed = raw.Trim();
        if (trimmed.Length == 0) return null;
        if (trimmed.Length <= maxChars) return trimmed;
        // Suffix truncation — same as Swift's String.suffix(maxChars)
        return $"... (truncated) {trimmed[^maxChars..]}";
    }
}
