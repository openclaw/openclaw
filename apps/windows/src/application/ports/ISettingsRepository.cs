using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Persists AppSettings to %APPDATA%\OpenClaw\settings.json.
/// Write-then-rename for atomicity
/// </summary>
public interface ISettingsRepository
{
    Task<AppSettings> LoadAsync(CancellationToken ct);
    Task SaveAsync(AppSettings settings, CancellationToken ct);
    /// <summary>
    /// Persists settings to the local JSON file only, skipping any remote gateway sync.
    /// Use when the gateway is intentionally offline (e.g. resuming a paused remote session).
    /// </summary>
    Task SaveLocalAsync(AppSettings settings, CancellationToken ct);
}
