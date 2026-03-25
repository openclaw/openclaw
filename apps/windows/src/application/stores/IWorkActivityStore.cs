using System.Text.Json;
using OpenClawWindows.Domain.WorkActivity;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// Tracks current agent work activity (active jobs and tools) per session.
/// </summary>
internal interface IWorkActivityStore
{
    WorkActivity? Current { get; }
    IconState IconState { get; }
    string? LastToolLabel { get; }
    DateTimeOffset? LastToolUpdatedAt { get; }
    string MainSessionKey { get; }

    // Raised after any state mutation — consumers update tray icon or UI.
    event EventHandler? StateChanged;

    void HandleJob(string sessionKey, string state);
    void HandleTool(string sessionKey, string phase, string? name, string? meta, JsonElement? args);
    void SetMainSessionKey(string sessionKey);

    // Apply a manual icon override in macOS).
    // Pass IconOverrideSelection.System to restore auto-derived state.
    void ResolveIconState(IconOverrideSelection overrideSelection);
}
