using Microsoft.UI;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Media;
using WinUIApplication = Microsoft.UI.Xaml.Application;

namespace OpenClawWindows.Presentation.Converters;

// true → SystemFillColorSuccessBrush (green), false → SystemFillColorCriticalBrush (red).
public sealed class BoolToGreenRedBrushConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        bool flag = value is bool b && b;
        var key = flag ? "SystemFillColorSuccessBrush" : "SystemFillColorCriticalBrush";

        if (WinUIApplication.Current.Resources.TryGetValue(key, out var resource))
        {
            if (resource is Brush themed)
                return themed;
        }

        // Fallback for design-time or resource-unavailable contexts.
        return new SolidColorBrush(flag ? Colors.Green : Colors.Red);
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException();
}
