using Microsoft.UI;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Media;

namespace OpenClawWindows.Presentation.Converters;

// Converts HealthStatusColor string ("green"|"orange"|"red"|"blue"|"gray") to a SolidColorBrush.
// Used by the health status dot in TrayContextMenu.xaml.
public sealed class StatusColorToBrushConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        var color = value as string ?? "gray";
        return color switch
        {
            "green"  => new SolidColorBrush(Colors.SeaGreen),
            "orange" => new SolidColorBrush(Colors.Orange),
            "red"    => new SolidColorBrush(Colors.Crimson),
            "blue"   => new SolidColorBrush(Colors.CornflowerBlue),
            _        => new SolidColorBrush(Colors.Gray),
        };
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException();
}
