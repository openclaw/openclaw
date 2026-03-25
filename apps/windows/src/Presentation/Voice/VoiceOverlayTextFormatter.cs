using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace OpenClawWindows.Presentation.Voice;

internal static class VoiceOverlayTextFormatter
{
    // Tunables
    internal const double FontSize = 13.0;

    internal static readonly Color VolatileDimColor = Color.FromArgb(0x66, 0x80, 0x80, 0x80);

    internal static string Delta(string committed, string current)
    {
        if (current.StartsWith(committed, StringComparison.Ordinal))
            return current[committed.Length..];
        return current;
    }

    // Returns two Run elements for insertion into a RichTextBlock Paragraph.
    // Committed run: inherits foreground (= labelColor). Volatile run: dim color when !isFinal.
    internal static (Run Committed, Run Volatile) MakeRuns(
        string committed, string volatile_, bool isFinal)
    {
        var committedRun = new Run { Text = committed, FontSize = FontSize };
        var volatileRun  = new Run { Text = volatile_,  FontSize = FontSize };

        if (!isFinal)
            volatileRun.Foreground = new SolidColorBrush(VolatileDimColor);

        return (committedRun, volatileRun);
    }
}
