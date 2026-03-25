using OpenClawWindows.Application.Behaviors;

namespace OpenClawWindows.Application.VoiceWake;

[UseCase("UC-034")]
public sealed record HandleBatterySaverModeCommand(bool IsBatterySaver) : IRequest<ErrorOr<Success>>;

internal sealed class HandleBatterySaverModeHandler
    : IRequestHandler<HandleBatterySaverModeCommand, ErrorOr<Success>>
{
    private readonly IPorcupineDetector _porcupineDetector;
    private readonly IMediator _mediator;
    private readonly ILogger<HandleBatterySaverModeHandler> _logger;

    public HandleBatterySaverModeHandler(IPorcupineDetector porcupineDetector, IMediator mediator,
        ILogger<HandleBatterySaverModeHandler> logger)
    {
        _porcupineDetector = porcupineDetector;
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(HandleBatterySaverModeCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Battery saver mode changed: isBatterySaver={IsBatterySaver}", cmd.IsBatterySaver);

        if (cmd.IsBatterySaver && _porcupineDetector.IsRunning)
        {
            await _mediator.Send(new StopVoiceWakeCommand(), ct);
        }
        else if (!cmd.IsBatterySaver && _porcupineDetector.WasSuspendedByBatterySaver)
        {
            await _mediator.Send(new StartVoiceWakeCommand(), ct);
        }

        return Result.Success;
    }
}
