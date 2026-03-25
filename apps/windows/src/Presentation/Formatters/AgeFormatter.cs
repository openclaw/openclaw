namespace OpenClawWindows.Presentation.Formatters;

internal static class AgeFormatter
{
    internal static string Age(DateTimeOffset date, DateTimeOffset? now = null)
    {
        var reference = now ?? DateTimeOffset.UtcNow;
        var seconds = Math.Max(0, (int)(reference - date).TotalSeconds);
        var minutes = seconds / 60;
        var hours = minutes / 60;
        var days = hours / 24;

        if (seconds < 60) return "just now";
        if (minutes == 1) return "1 minute ago";
        if (minutes < 60) return $"{minutes}m ago";
        if (hours == 1) return "1 hour ago";
        if (hours < 24) return $"{hours}h ago";
        if (days == 1) return "yesterday";
        return $"{days}d ago";
    }
}
