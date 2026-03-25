namespace OpenClawWindows.Presentation.Formatters;

internal static class PlatformLabelFormatter
{
    internal static (string Prefix, string? Version) Parse(string raw)
    {
        var trimmed = raw.Trim();
        if (trimmed.Length == 0) return ("", null);
        var parts = trimmed.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
        var prefix = parts[0].ToLowerInvariant();
        var version = parts.Length > 1 ? parts[1] : null;
        return (prefix, version);
    }

    internal static string? Pretty(string raw)
    {
        var (prefix, version) = Parse(raw);
        if (prefix.Length == 0) return null;

        var name = prefix switch
        {
            "macos"   => "macOS",
            "ios"     => "iOS",
            "ipados"  => "iPadOS",
            "tvos"    => "tvOS",
            "watchos" => "watchOS",
            _         => char.ToUpperInvariant(prefix[0]) + prefix[1..]
        };

        if (string.IsNullOrEmpty(version)) return name;

        var versionParts = version.Split('.');
        if (versionParts.Length >= 2)
            return $"{name} {versionParts[0]}.{versionParts[1]}";

        return $"{name} {version}";
    }
}
