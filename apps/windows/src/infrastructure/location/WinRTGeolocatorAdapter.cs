using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Windows.Devices.Geolocation;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Infrastructure.Location;

// GPS/WiFi geolocation via Windows.Devices.Geolocation.Geolocator.
// Requires 'location' capability in Package.appxmanifest.
internal sealed class WinRTGeolocatorAdapter : IGeolocator
{
    // Tunables
    private const int DefaultTimeoutMs = 10_000;

    private readonly ILogger<WinRTGeolocatorAdapter> _logger;

    public WinRTGeolocatorAdapter(ILogger<WinRTGeolocatorAdapter> logger)
    {
        _logger = logger;
    }

    public async Task<ErrorOr<LocationReading>> GetCurrentLocationAsync(
        string? desiredAccuracy,
        int? maxAgeMs,
        int? timeoutMs,
        CancellationToken ct)
    {
        var status = await Geolocator.RequestAccessAsync().AsTask(ct);
        if (status != GeolocationAccessStatus.Allowed)
        {
            _logger.LogWarning("Location permission not granted (status={S})", status);
            return Error.Failure("PERMISSION_MISSING: location");
        }

        var locator = new Geolocator
        {
            // "precise" maps to PositionAccuracy.High (GPS); all others use Default (WiFi/cell)
            DesiredAccuracy = desiredAccuracy == "precise"
                ? PositionAccuracy.High
                : PositionAccuracy.Default,
        };

        // maximumAge=0 means ignore cache and request fresh
        var maximumAge = maxAgeMs.HasValue
            ? TimeSpan.FromMilliseconds(maxAgeMs.Value)
            : TimeSpan.Zero;
        var timeout = TimeSpan.FromMilliseconds(timeoutMs ?? DefaultTimeoutMs);

        try
        {
            var pos = await locator.GetGeopositionAsync(maximumAge, timeout).AsTask(ct);
            var coord = pos.Coordinate;

            // Windows has no reduced-accuracy permission concept; access granted = full accuracy
            return LocationReading.Create(
                latitude: coord.Latitude,
                longitude: coord.Longitude,
                accuracy: coord.Accuracy,
                altitude: coord.Altitude,
                speed: coord.Speed,
                heading: coord.Heading,
                timestamp: coord.Timestamp.ToUnixTimeMilliseconds(),
                isPrecise: true);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            // Timeout specified in the overload elapsed before a fix was obtained
            return Error.Failure("LOCATION_TIMEOUT: no fix in time");
        }
        catch (Exception ex) when (ex.HResult == unchecked((int)0x800705B4))
        {
            // WAIT_TIMEOUT HRESULT from WinRT Geolocator when internal timeout expires
            return Error.Failure("LOCATION_TIMEOUT: no fix in time");
        }
        catch (Exception ex) when (ex.HResult == unchecked((int)0x80070005))
        {
            return Error.Failure("PERMISSION_MISSING: location");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Geolocation failed");
            return Error.Failure("LOCATION_UNAVAILABLE", ex.Message);
        }
    }

    public async IAsyncEnumerable<LocationReading> WatchPositionAsync(
        string? desiredAccuracy,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var status = await Geolocator.RequestAccessAsync().AsTask(ct);
        if (status != GeolocationAccessStatus.Allowed)
        {
            _logger.LogWarning("Location permission not granted — WatchPosition aborting");
            yield break;
        }

        var locator = new Geolocator
        {
            DesiredAccuracy = desiredAccuracy == "precise"
                ? PositionAccuracy.High
                : PositionAccuracy.Default,
            // 50 m movement threshold
            MovementThreshold = 50,
        };

        // Bounded channel drops oldest on overflow so the caller is never flooded
        var channel = Channel.CreateBounded<LocationReading>(
            new BoundedChannelOptions(4) { FullMode = BoundedChannelFullMode.DropOldest });

        void OnPositionChanged(Geolocator _, PositionChangedEventArgs args)
        {
            var coord = args.Position.Coordinate;
            try
            {
                var reading = LocationReading.Create(
                    coord.Latitude, coord.Longitude, coord.Accuracy,
                    coord.Altitude, coord.Speed, coord.Heading,
                    coord.Timestamp.ToUnixTimeMilliseconds(), isPrecise: true);
                channel.Writer.TryWrite(reading);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "WatchPosition: skipped invalid reading");
            }
        }

        locator.PositionChanged += OnPositionChanged;

        // Complete the channel when the caller cancels so ReadAllAsync terminates cleanly
        using var reg = ct.Register(() => channel.Writer.TryComplete());
        try
        {
            await foreach (var reading in channel.Reader.ReadAllAsync(CancellationToken.None).ConfigureAwait(false))
                yield return reading;
        }
        finally
        {
            locator.PositionChanged -= OnPositionChanged;
        }
    }
}
