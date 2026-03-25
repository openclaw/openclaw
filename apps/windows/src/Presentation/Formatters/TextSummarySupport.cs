using System.Text.RegularExpressions;

namespace OpenClawWindows.Presentation.Formatters;

internal static partial class TextSummarySupport
{
    // Tunables
    private const int DefaultMaxLength = 200;

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRun();

    internal static string? SummarizeLastLine(string text, int maxLength = DefaultMaxLength)
    {
        var last = text
            .Split(new[] { '\n', '\r' }, StringSplitOptions.None)
            .Select(l => l.Trim())
            .LastOrDefault(l => l.Length > 0);

        if (last is null) return null;

        var normalized = WhitespaceRun().Replace(last, " ");

        if (normalized.Length > maxLength)
            return normalized[..(maxLength - 1)] + "…";

        return normalized;
    }
}
