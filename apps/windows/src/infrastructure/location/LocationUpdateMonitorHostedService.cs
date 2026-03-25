using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Location;

// Sends location.update events to the gateway via the node WebSocket when LocationMode is Always.
// Uses Geolocator.PositionChanged with a 50 m movement threshold.
internal sealed class LocationUpdateMonitorHostedService : IHostedService
{
    // Tunables
    private const int SettingsPollMs = 30_000;  // poll interval when not streaming

    private readonly ISettingsRepository _settings;
    private readonly IGeolocator _geolocator;
    private readonly INodeEventSink _eventSink;
    private readonly ILogger<LocationUpdateMonitorHostedService> _logger;

    private CancellationTokenSource? _cts;

    public LocationUpdateMonitorHostedService(
        ISettingsRepository settings,
        IGeolocator geolocator,
        INodeEventSink eventSink,
        ILogger<LocationUpdateMonitorHostedService> logger)
    {
        _settings = settings;
        _geolocator = geolocator;
        _eventSink = eventSink;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _ = Task.Run(() => RunAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            AppSettings settings;
            try
            {
                settings = await _settings.LoadAsync(ct);
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Location monitor: settings load failed");
                try { await Task.Delay(SettingsPollMs, ct); }
                catch (OperationCanceledException) { return; }
                continue;
            }

            if (settings.LocationMode == LocationMode.Always)
            {
                // Stream position until mode changes or token cancels
                await MonitorPositionAsync(ct);
            }
            else
            {
                // Not in Always mode — sleep then re-check
                try { await Task.Delay(SettingsPollMs, ct); }
                catch (OperationCanceledException) { return; }
            }
        }
    }

    private async Task MonitorPositionAsync(CancellationToken ct)
    {
        _logger.LogInformation("Location monitor: starting continuous position watch");
        try
        {
            await foreach (var loc in _geolocator.WatchPositionAsync(null, ct).ConfigureAwait(false))
            {
                var payload = JsonSerializer.Serialize(new LocationUpdatePayload
                {
                    Lat = loc.Latitude,
                    Lon = loc.Longitude,
                    AccuracyMeters = loc.Accuracy,
                    AltitudeMeters = loc.Altitude,
                    Source = "windows-geolocator",
                });

                _eventSink.TrySendEvent("location.update", payload);
                _logger.LogDebug("Location update sent lat={Lat} lon={Lon}", loc.Latitude, loc.Longitude);

                // Stop streaming if the mode was changed while we were watching
                AppSettings current;
                try { current = await _settings.LoadAsync(ct); }
                catch { break; }
                if (current.LocationMode != LocationMode.Always) break;
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { _logger.LogError(ex, "Location monitor: position watch failed"); }

        _logger.LogInformation("Location monitor: continuous position watch stopped");
    }

    // JSON payload matching OpenClawLocationPayload — field names must match the iOS/gateway schema
    private sealed class LocationUpdatePayload
    {
        [JsonPropertyName("lat")] public double Lat { get; init; }
        [JsonPropertyName("lon")] public double Lon { get; init; }
        [JsonPropertyName("accuracyMeters")] public double AccuracyMeters { get; init; }
        [JsonPropertyName("altitudeMeters")] public double? AltitudeMeters { get; init; }
        [JsonPropertyName("source")] public string? Source { get; init; }
    }
}
