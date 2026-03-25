using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-016")]
public sealed record GetLocationQuery(
    string? DesiredAccuracy = null,
    int? MaxAgeMs = null,
    int? TimeoutMs = null) : IRequest<ErrorOr<LocationReading>>;

internal sealed class GetLocationHandler : IRequestHandler<GetLocationQuery, ErrorOr<LocationReading>>
{
    private readonly IGeolocator _geolocator;
    private readonly ISettingsRepository _settings;
    private readonly ILogger<GetLocationHandler> _logger;

    public GetLocationHandler(IGeolocator geolocator, ISettingsRepository settings, ILogger<GetLocationHandler> logger)
    {
        _geolocator = geolocator;
        _settings = settings;
        _logger = logger;
    }

    public async Task<ErrorOr<LocationReading>> Handle(GetLocationQuery query, CancellationToken ct)
    {
        var appSettings = await _settings.LoadAsync(ct);

        // Gate on app-level location mode
        if (appSettings.LocationMode == LocationMode.Off)
            return Error.Failure("LOCATION_DISABLED: enable Location in Settings");

        _logger.LogInformation("location.get requested (accuracy={A}, maxAge={M}, timeout={T})",
            query.DesiredAccuracy, query.MaxAgeMs, query.TimeoutMs);

        return await _geolocator.GetCurrentLocationAsync(
            query.DesiredAccuracy,
            query.MaxAgeMs,
            query.TimeoutMs,
            ct);
    }
}
