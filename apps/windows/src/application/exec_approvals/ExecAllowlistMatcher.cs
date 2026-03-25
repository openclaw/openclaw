using System.Text.RegularExpressions;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

// Matches command resolutions against user-configured allowlist patterns using glob syntax.
internal static class ExecAllowlistMatcher
{
    // Returns the first allowlist entry whose pattern matches the given resolution.
    internal static ExecAllowlistEntry? Match(
        IReadOnlyList<ExecAllowlistEntry> entries,
        ExecCommandResolution? resolution)
    {
        if (resolution is null || entries.Count == 0) return null;
        var rawExecutable = resolution.RawExecutable;
        var resolvedPath  = resolution.ResolvedPath;

        foreach (var entry in entries)
        {
            if (ExecApprovalHelpers.ValidateAllowlistPattern(entry.Pattern)
                is not ExecAllowlistPatternValidation.Valid valid)
                continue;

            // Prefer the fully-resolved path; fall back to the raw executable token.
            var target = resolvedPath ?? rawExecutable;
            if (Matches(valid.Pattern, target))
                return entry;
        }
        return null;
    }

    // Returns the list of matching entries — one per resolution — or empty when any resolution
    // fails to match (all-or-nothing semantics mirror matchAll in Swift).
    internal static IReadOnlyList<ExecAllowlistEntry> MatchAll(
        IReadOnlyList<ExecAllowlistEntry> entries,
        IReadOnlyList<ExecCommandResolution> resolutions)
    {
        if (entries.Count == 0 || resolutions.Count == 0) return [];

        var matches = new List<ExecAllowlistEntry>(resolutions.Count);
        foreach (var resolution in resolutions)
        {
            var match = Match(entries, resolution);
            if (match is null) return []; // Fail entire chain on first miss.
            matches.Add(match);
        }
        return matches;
    }

    // ─── Pattern matching ─────────────────────────────────────────────────────

    private static bool Matches(string pattern, string target)
    {
        var trimmed = pattern.Trim();
        if (trimmed.Length == 0) return false;

        var expanded = trimmed.StartsWith('~')
            ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + trimmed[1..]
            : trimmed;

        var normalizedPattern = NormalizeMatchTarget(expanded);
        var normalizedTarget  = NormalizeMatchTarget(target);

        var regex = BuildRegex(normalizedPattern);
        return regex?.IsMatch(normalizedTarget) == true;
    }

    // Normalizes path separators to '/' and lowercases for case-insensitive matching.
    private static string NormalizeMatchTarget(string value) =>
        value.Replace('\\', '/').ToLowerInvariant();

    // Compiles the glob pattern to a Regex:
    //   **  →  .*     (matches across directory separators)
    //   *   →  [^/]*  (matches within a single path component)
    //   ?   →  .      (matches any single character)
    //   other chars are regex-escaped.
    private static Regex? BuildRegex(string pattern)
    {
        var sb = new System.Text.StringBuilder("^");
        for (int i = 0; i < pattern.Length; i++)
        {
            var ch = pattern[i];
            if (ch == '*')
            {
                if (i + 1 < pattern.Length && pattern[i + 1] == '*')
                {
                    sb.Append(".*");
                    i++; // skip second '*'
                }
                else
                {
                    sb.Append("[^/]*");
                }
                continue;
            }
            if (ch == '?') { sb.Append('.'); continue; }
            sb.Append(Regex.Escape(ch.ToString()));
        }
        sb.Append('$');

        try
        {
            return new Regex(sb.ToString(),
                RegexOptions.IgnoreCase | RegexOptions.Compiled,
                TimeSpan.FromSeconds(1));
        }
        catch
        {
            return null;
        }
    }
}
