using Windows.Graphics;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Manages the lifecycle of the web chat window and panel.
/// </summary>
public interface IWebChatManager
{
    // The session key of whichever window/panel is currently showing.
    string? ActiveSessionKey { get; }

    // True if a chat panel currently exists (visible or hidden).
    bool HasPanel { get; }

    // Session key of the current panel, if any.
    string? CurrentPanelSessionKey { get; }

    // Open a full (titled, resizable) chat window for sessionKey.
    Task ShowAsync(string sessionKey, CancellationToken ct = default);

    // Toggle the anchored panel for sessionKey.
    // anchorPoint: physical pixel origin (tray icon cursor position) for placement.
    Task TogglePanelAsync(
        string sessionKey,
        PointInt32? anchorPoint = null,
        CancellationToken ct = default);

    // Close the panel without touching the full window.
    void ClosePanel();

    // Close all windows and reset cached session keys.
    void ResetAll();

    // Returns the main session key from the gateway, caching it for the lifetime.
    Task<string> GetPreferredSessionKeyAsync(CancellationToken ct = default);
}
