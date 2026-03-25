namespace OpenClawWindows.Application.ExecApprovals;

internal static class ExecCommandToken
{
    // Returns the lowercased last path component (basename) of a token.
    internal static string BasenameLower(string token)
    {
        var trimmed = token.Trim();
        if (trimmed.Length == 0) return string.Empty;
        var normalized = trimmed.Replace('\\', '/');
        var parts = normalized.Split('/');
        return (parts[^1].Length > 0 ? parts[^1] : normalized).ToLowerInvariant();
    }
}
