using Microsoft.UI.Xaml.Data;

namespace OpenClawWindows.Presentation.Converters;

// Returns 1.0 when true, 0.5 when false — used for the Voice Wake toggle opacity.
public sealed class BoolToOpacityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
        => value is true ? 1.0 : 0.5;

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException();
}
