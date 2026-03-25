namespace OpenClawWindows.Domain.Settings;

// On Windows there is no background "always" distinction, but the mode still gates
// whether the node may service location.get requests.
public enum LocationMode
{
    Off,
    WhileUsing,
    Always,
}
