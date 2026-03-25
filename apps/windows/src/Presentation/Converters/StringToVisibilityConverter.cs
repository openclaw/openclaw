using Microsoft.UI.Xaml.Data;

namespace OpenClawWindows.Presentation.Converters;

// Shows Visible when the bound string is non-null and non-empty; Collapsed otherwise.
// Pass ConverterParameter="Invert" to reverse: Visible when null/empty.
// Used to hide error banners, status labels, and validation messages when blank.
public sealed class StringToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        bool hasContent = value is string s && !string.IsNullOrEmpty(s);
        bool invert = parameter is string p && p.Equals("Invert", StringComparison.OrdinalIgnoreCase);
        return (hasContent ^ invert) ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException();
}
