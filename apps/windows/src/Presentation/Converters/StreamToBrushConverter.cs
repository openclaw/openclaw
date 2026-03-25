using Microsoft.UI;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Media;

namespace OpenClawWindows.Presentation.Converters;

public sealed class StreamToBrushConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        var stream = value as string ?? string.Empty;
        var color = stream switch
        {
            "job"       => Colors.SteelBlue,
            "tool"      => Colors.DarkOrange,
            "assistant" => Colors.SeaGreen,
            _           => Colors.Gray,
        };
        return new SolidColorBrush(color);
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException();
}
