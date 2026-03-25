using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Settings;

[UseCase("UC-035")]
public sealed record SaveSettingsCommand(AppSettings Settings) : IRequest<ErrorOr<Success>>;

internal sealed class SaveSettingsHandler : IRequestHandler<SaveSettingsCommand, ErrorOr<Success>>
{
    private readonly ISettingsRepository _settings;
    private readonly IMediator _mediator;
    private readonly ILogger<SaveSettingsHandler> _logger;

    public SaveSettingsHandler(ISettingsRepository settings, IMediator mediator, ILogger<SaveSettingsHandler> logger)
    {
        _settings = settings;
        _mediator = mediator;
        _logger   = logger;
    }

    public async Task<ErrorOr<Success>> Handle(SaveSettingsCommand cmd, CancellationToken ct)
    {
        Guard.Against.Null(cmd.Settings, nameof(cmd.Settings));

        await _settings.SaveAsync(cmd.Settings, ct);
        _logger.LogInformation("Settings saved to {Path}", cmd.Settings.AppDataPath);

        // Apply connection mode after save
        await _mediator.Send(new ApplyConnectionModeCommand(cmd.Settings), ct);

        return Result.Success;
    }
}
