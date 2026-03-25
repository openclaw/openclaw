using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Settings;

[UseCase("UC-034")]
public sealed record GetSettingsQuery : IRequest<ErrorOr<AppSettings>>;

internal sealed class GetSettingsHandler : IRequestHandler<GetSettingsQuery, ErrorOr<AppSettings>>
{
    private readonly ISettingsRepository _settings;

    public GetSettingsHandler(ISettingsRepository settings)
    {
        _settings = settings;
    }

    public async Task<ErrorOr<AppSettings>> Handle(GetSettingsQuery _, CancellationToken ct)
    {
        var settings = await _settings.LoadAsync(ct);
        return settings;
    }
}
