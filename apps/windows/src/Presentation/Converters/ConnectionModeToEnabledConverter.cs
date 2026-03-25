using Microsoft.UI.Xaml.Data;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Presentation.Converters;

// Returns false when ConnectionMode is Unconfigured.
public sealed class ConnectionModeToEnabledConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
        => value is ConnectionMode mode && mode != ConnectionMode.Unconfigured;

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException();
}
