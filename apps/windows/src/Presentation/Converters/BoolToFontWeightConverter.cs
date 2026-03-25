using Microsoft.UI.Text;
using Microsoft.UI.Xaml.Data;
using Windows.UI.Text;

namespace OpenClawWindows.Presentation.Converters;

// Maps a bool to FontWeight: true → SemiBold, false → Normal.
// Used by ContextMenuCardView to highlight the main session row.
public sealed class BoolToFontWeightConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
        => value is true ? FontWeights.SemiBold : FontWeights.Normal;

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => value is FontWeight fw && fw.Weight == FontWeights.SemiBold.Weight;
}
