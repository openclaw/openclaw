namespace OpenClawWindows.Domain.Instances;

// Normalized view of a presence entry returned by the gateway system-presence RPC.
public sealed record InstanceInfo(
    string Id,
    string? Host,
    string? Ip,
    string? Version,
    string? Platform,
    string? DeviceFamily,
    string? ModelIdentifier,
    int? LastInputSeconds,
    string? Mode,
    string? Reason,
    string Text,
    double TsMs)
{
    // Formatted relative age
    public string AgeDescription => FormatAge(TsMs);

    // Formatted last input idle time
    public string LastInputDescription =>
        LastInputSeconds.HasValue ? $"{LastInputSeconds}s ago" : "unknown";

    private static string FormatAge(double tsMs)
    {
        var date = DateTimeOffset.FromUnixTimeMilliseconds((long)tsMs);
        var age = DateTimeOffset.UtcNow - date;

        if (age.TotalSeconds < 60) return $"{(int)age.TotalSeconds}s ago";
        if (age.TotalMinutes < 60) return $"{(int)age.TotalMinutes}m ago";
        if (age.TotalHours < 24)   return $"{(int)age.TotalHours}h ago";
        return $"{(int)age.TotalDays}d ago";
    }
}
