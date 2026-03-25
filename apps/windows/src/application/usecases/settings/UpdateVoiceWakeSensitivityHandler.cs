using OpenClawWindows.Application.Behaviors;

namespace OpenClawWindows.Application.Settings;

[UseCase("UC-037")]
public sealed record UpdateVoiceWakeSensitivityCommand(float Sensitivity) : IRequest<ErrorOr<Success>>;

internal sealed class UpdateVoiceWakeSensitivityHandler
    : IRequestHandler<UpdateVoiceWakeSensitivityCommand, ErrorOr<Success>>
{
    private readonly IPorcupineDetector _porcupineDetector;
    private readonly IMediator _mediator;
    private readonly ILogger<UpdateVoiceWakeSensitivityHandler> _logger;

    public UpdateVoiceWakeSensitivityHandler(IPorcupineDetector porcupineDetector, IMediator mediator,
        ILogger<UpdateVoiceWakeSensitivityHandler> logger)
    {
        _porcupineDetector = porcupineDetector;
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(UpdateVoiceWakeSensitivityCommand cmd, CancellationToken ct)
    {
        if (cmd.Sensitivity is < 0.0f or > 1.0f)
            return Error.Validation("VW.INVALID_SENSITIVITY", "Sensitivity must be in [0.0, 1.0]");

        var settingsResult = await _mediator.Send(new GetSettingsQuery(), ct);
        if (settingsResult.IsError)
            return settingsResult.Errors;

        var settings = settingsResult.Value;
        var sensitivityResult = settings.SetVoiceWakeSensitivity(cmd.Sensitivity);
        if (sensitivityResult.IsError)
            return sensitivityResult.Errors;

        await _mediator.Send(new SaveSettingsCommand(settings), ct);

        if (_porcupineDetector.IsRunning)
            await _porcupineDetector.SetSensitivityAsync(cmd.Sensitivity, ct);

        _logger.LogInformation("VoiceWake sensitivity updated to {Sensitivity}", cmd.Sensitivity);
        return Result.Success;
    }
}
