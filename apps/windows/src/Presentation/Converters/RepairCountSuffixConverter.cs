using Microsoft.UI.Xaml.Data;

namespace OpenClawWindows.Presentation.Converters;

/// <summary>
/// Converts a repair count (int) to a suffix string for tray menu pairing status lines.
///   repairCount > 0 ? " · \(repairCount) repair" : ""
/// </summary>
public sealed class RepairCountSuffixConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) =>
        value is int n && n > 0 ? $" · {n} repair" : string.Empty;

    public object ConvertBack(object value, Type targetType, object parameter, string language) =>
        throw new NotSupportedException();
}
