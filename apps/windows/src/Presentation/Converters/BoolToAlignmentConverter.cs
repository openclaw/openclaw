using Microsoft.UI.Xaml.Data;

namespace OpenClawWindows.Presentation.Converters;

// Maps IsUser bool to HorizontalAlignment: true → Right, false → Left.
public sealed class BoolToAlignmentConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
        => value is true ? HorizontalAlignment.Right : HorizontalAlignment.Left;

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => value is HorizontalAlignment.Right;
}
