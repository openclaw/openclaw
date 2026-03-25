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
}
