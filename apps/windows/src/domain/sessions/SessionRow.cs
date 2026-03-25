namespace OpenClawWindows.Domain.Sessions;

public sealed record SessionRow
{
    public required string Key { get; init; }
    public string? DisplayName { get; init; }
    public string? Provider { get; init; }
    public string? Subject { get; init; }
    public string? Room { get; init; }
    public string? Space { get; init; }
    public DateTimeOffset? UpdatedAt { get; init; }
    public string? SessionId { get; init; }
    public string? ThinkingLevel { get; init; }
    public string? VerboseLevel { get; init; }
    public bool SystemSent { get; init; }
    public bool AbortedLastRun { get; init; }
    public int InputTokens { get; init; }
    public int OutputTokens { get; init; }
    public int TotalTokens { get; init; }
    public int ContextTokens { get; init; }
    public string? Model { get; init; }

    public SessionKind Kind => SessionKindHelper.From(Key);
    public string Label => DisplayName ?? Key;

    public string AgeText
    {
        get
        {
            if (!UpdatedAt.HasValue) return "unknown";
            var delta = DateTimeOffset.UtcNow - UpdatedAt.Value;
            if (delta.TotalMinutes < 1) return "just now";
            var minutes = (int)Math.Round(delta.TotalMinutes);
            if (minutes < 60) return $"{minutes}m ago";
            var hours = (int)Math.Round(delta.TotalHours);
            if (hours < 48) return $"{hours}h ago";
            var days = (int)Math.Round(delta.TotalDays);
            return $"{days}d ago";
        }
    }

    public string ContextSummaryShort =>
        $"{FormatKTokens(TotalTokens)}/{FormatKTokens(ContextTokens)}";

    public int? PercentUsed
    {
        get
        {
            if (ContextTokens <= 0 || TotalTokens <= 0) return null;
            return Math.Min(100, (int)Math.Round((double)TotalTokens / ContextTokens * 100));
        }
    }

    public IReadOnlyList<string> FlagLabels
    {
        get
        {
            var flags = new List<string>();
            if (ThinkingLevel is not null) flags.Add($"think {ThinkingLevel}");
            if (VerboseLevel is not null) flags.Add($"verbose {VerboseLevel}");
            if (SystemSent) flags.Add("system sent");
            if (AbortedLastRun) flags.Add("aborted");
            return flags;
        }
    }

    private static string FormatKTokens(int value)
    {
        if (value < 1000) return value.ToString();
        var thousands = (double)value / 1000;
        var decimals = value >= 10_000 ? 0 : 1;
        return thousands.ToString($"F{decimals}") + "k";
    }
}
