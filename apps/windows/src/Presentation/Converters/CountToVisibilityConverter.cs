using Microsoft.UI.Xaml.Data;

namespace OpenClawWindows.Presentation.Converters;

// Returns Visible when the integer count is greater than zero.
// Used by TrayContextMenu.xaml to show the sessions section only when there are sessions.
public sealed class CountToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
        => value is int count && count > 0 ? Visibility.Visible : Visibility.Collapsed;

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException();
}
