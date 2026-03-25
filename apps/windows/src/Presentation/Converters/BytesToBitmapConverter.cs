using System.IO;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Media.Imaging;

namespace OpenClawWindows.Presentation.Converters;

// Converts byte[] to BitmapImage for inline image display in chat bubbles.
// Returns null when bytes is null/empty — Image control renders nothing.
public sealed class BytesToBitmapConverter : IValueConverter
{
    public object? Convert(object value, Type targetType, object parameter, string language)
    {
        if (value is not byte[] bytes || bytes.Length == 0) return null;
        try
        {
            var bmp = new BitmapImage();
            using var ms = new MemoryStream(bytes);
            bmp.SetSource(ms.AsRandomAccessStream());
            return bmp;
        }
        catch
        {
            return null;
        }
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language)
        => throw new NotSupportedException("BytesToBitmapConverter is one-way only.");
}
