using CommunityToolkit.Mvvm.ComponentModel;

namespace OpenClawWindows.Domain.Updates;

// IsUpdateReady = true when an update has been downloaded and can be applied on restart.
public sealed partial class UpdateStatus : ObservableObject
{
    public static readonly UpdateStatus Disabled = new();

    [ObservableProperty]
    private bool _isUpdateReady;
}
