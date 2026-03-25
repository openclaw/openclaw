using System.Text.RegularExpressions;

namespace OpenClawWindows.Presentation.Helpers;

/// <summary>
/// Strips thinking segments from assistant text before rendering.
/// With showsAssistantTrace=false (our default), only "response" segments are visible.
/// </summary>
internal static class AssistantTextParser
{
    // Matches <think>...</think> and <final>...</final> including unclosed tags at end of stream.
    // Case-insensitive. Multiline content. Non-greedy.
    private static readonly Regex ThinkBlock = new(
        @"<think(?:\s[^>]*)?>.*?</think\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled);

    // Strips unclosed <think> at end of streaming text (partial assistant response).
    private static readonly Regex UnclosedThinkAtEnd = new(
        @"<think(?:\s[^>]*)?>.*$",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled);

    // Strips <final> / </final> wrapper tags — content inside is kept.
    private static readonly Regex FinalTags = new(
        @"</?final(?:\s[^>]*)?>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Returns the text with thinking blocks removed, ready for markdown rendering.
    /// </summary>
    public static string StripThinking(string text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        if (!text.Contains('<')) return text;

        // Remove complete <think>…</think> blocks.
        var result = ThinkBlock.Replace(text, string.Empty);

        // Remove unclosed <think> that trails at the end (streaming partial).
        result = UnclosedThinkAtEnd.Replace(result, string.Empty);

        // Strip <final>/<final/> wrapper tags but keep their content.
        result = FinalTags.Replace(result, string.Empty);

        // Normalize runs of blank lines left by removed blocks.
        result = Normalize(result);

        return result;
    }

    /// <summary>
    /// Returns true if there is visible (non-thinking) content in the text.
    /// </summary>
    public static bool HasVisibleContent(string text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        var stripped = StripThinking(text);
        return !string.IsNullOrWhiteSpace(stripped);
    }

    private static string Normalize(string text)
    {
        // Collapse 3+ consecutive newlines to 2
        var result = text.Replace("\r\n", "\n");
        while (result.Contains("\n\n\n"))
            result = result.Replace("\n\n\n", "\n\n");
        return result.Trim();
    }
}
