using Microsoft.UI.Xaml;

namespace OpenClawWindows.Presentation.Helpers;

// WinUI3 uses SizeChanged on FrameworkElement to propagate measured widths.
internal static class ViewMetrics
{
    internal static double ReduceWidth(double current, double next) => Math.Max(current, next);

    // Returns a cleanup Action to unsubscribe
    internal static Action ObserveWidth(FrameworkElement element, Action<double> onChange)
    {
        void Handler(object _, SizeChangedEventArgs e) => onChange(e.NewSize.Width);
        element.SizeChanged += Handler;
        return () => element.SizeChanged -= Handler;
    }
}
