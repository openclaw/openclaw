using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Camera;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Permissions;

namespace OpenClawWindows.Infrastructure.NodeMode;

/// <summary>
/// OS-specific node runtime services.
/// IScreenCapture and IGeolocator are async — @MainActor thread confinement is not required — IScreenCapture and IGeolocator
/// are async and do not demand the UI thread.
/// </summary>
internal sealed class WindowsNodeRuntimeServices : IWindowsNodeRuntimeServices
{
    private readonly IScreenCapture                        _screenCapture;
    private readonly IGeolocator                           _geolocator;
    private readonly IPermissionManager                    _permissions;
    private readonly ILogger<WindowsNodeRuntimeServices>   _logger;

    public WindowsNodeRuntimeServices(
        IScreenCapture                       screenCapture,
        IGeolocator                          geolocator,
        IPermissionManager                   permissions,
        ILogger<WindowsNodeRuntimeServices>  logger)
    {
        _screenCapture = screenCapture;
        _geolocator    = geolocator;
        _permissions   = permissions;
        _logger        = logger;
    }

    // Windows returns ScreenRecordingResult directly; no temp-file round-trip required.
    public Task<ErrorOr<ScreenRecordingResult>> RecordScreenAsync(
        ScreenRecordingParams p, CancellationToken ct)
    {
        _logger.LogDebug(
            "node recordScreen durationMs={D} fps={F} screenIndex={I}",
            p.DurationMs, p.Fps, p.ScreenIndex);
        return _screenCapture.RecordAsync(p, ct);
    }

    // Returns true when Location permission is granted, false otherwise.
    public async Task<bool> IsLocationGrantedAsync(CancellationToken ct)
    {
        var statuses = await _permissions.StatusAsync([Capability.Location], ct);
        return statuses.TryGetValue(Capability.Location, out var granted) && granted;
    }

    // always reports full accuracy.
    public bool IsLocationFullAccuracy() => true;

    public Task<ErrorOr<LocationReading>> GetCurrentLocationAsync(
        string?           desiredAccuracy,
        int?              maxAgeMs,
        int?              timeoutMs,
        CancellationToken ct)
    {
        _logger.LogDebug(
            "node location.get accuracy={A} maxAgeMs={MA} timeoutMs={T}",
            desiredAccuracy ?? "default", maxAgeMs, timeoutMs);
        return _geolocator.GetCurrentLocationAsync(desiredAccuracy, maxAgeMs, timeoutMs, ct);
    }
}

/// <summary>Port for OS-specific node runtime services.</summary>
internal interface IWindowsNodeRuntimeServices
{
    Task<ErrorOr<ScreenRecordingResult>> RecordScreenAsync(ScreenRecordingParams p, CancellationToken ct);

    Task<bool> IsLocationGrantedAsync(CancellationToken ct);

    bool IsLocationFullAccuracy();

    Task<ErrorOr<LocationReading>> GetCurrentLocationAsync(
        string? desiredAccuracy, int? maxAgeMs, int? timeoutMs, CancellationToken ct);
}
