using Windows.UI;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class HoverHUDViewModel : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StatusTitle), nameof(DotColor), nameof(BadgeGlyph))]
    private bool _isWorking;

    [ObservableProperty]
    private string _detail = "No recent activity";

    public string StatusTitle => IsWorking ? "Working" : "Idle";

    // Semi-transparent green when working, muted gray when idle.
    public Color DotColor => IsWorking
        ? Color.FromArgb(178, 34, 197, 94)   // green-500 @ 70%
        : Color.FromArgb(102, 128, 128, 128); // secondary gray @ 40%

    // Segoe MDL2 glyphs: Sync (working) / Pause (idle).
    public string BadgeGlyph => IsWorking ? "\uE895" : "\uE769";

    public void Update(bool isWorking, string? currentLabel, string? lastLabel)
    {
        IsWorking = isWorking;
        Detail = !string.IsNullOrEmpty(currentLabel) ? currentLabel!
               : !string.IsNullOrEmpty(lastLabel)    ? lastLabel!
               : "No recent activity";
    }
}
