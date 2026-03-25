using OpenClawWindows.Domain.SystemTray;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// In-memory cache of the current tray menu state.
/// Populated by UpdateTrayMenuStateHandler; read by ShowTrayMenuHandler.
/// </summary>
public interface ITrayMenuStateStore
{
    TrayMenuState? Current { get; }
    void Update(TrayMenuState state);
}
