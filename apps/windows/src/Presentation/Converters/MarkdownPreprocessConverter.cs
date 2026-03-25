using Microsoft.UI.Xaml.Data;
using OpenClawWindows.Presentation.Helpers;

namespace OpenClawWindows.Presentation.Converters;

// Runs the same pipeline that MessageContent_Loaded used to run imperatively:
// raw string → ChatMarkdownPreprocessor.Preprocess → AssistantTextParser.StripThinking
// Used by MarkdownTextBlock bindings for completed (non-streaming) messages.
public sealed class MarkdownPreprocessConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        if (value is not string raw) return string.Empty;
        var cleaned = ChatMarkdownPreprocessor.Preprocess(raw);
        return AssistantTextParser.StripThinking(cleaned);
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException();
}
