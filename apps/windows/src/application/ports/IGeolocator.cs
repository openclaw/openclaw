using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Device geolocation via Windows.Devices.Geolocation.
/// </summary>
public interface IGeolocator
{
    Task<ErrorOr<LocationReading>> GetCurrentLocationAsync(
        string? desiredAccuracy,
        int? maxAgeMs,
        int? timeoutMs,
        CancellationToken ct);

    // Yields position updates as they arrive
    // Completes when ct is cancelled or the location provider becomes unavailable.
    IAsyncEnumerable<LocationReading> WatchPositionAsync(
        string? desiredAccuracy,
        CancellationToken ct);
}
