using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.VoiceWake;

[UseCase("UC-033")]
public sealed record StopVoiceWakeCommand : IRequest<ErrorOr<Success>>;

internal sealed class StopVoiceWakeHandler : IRequestHandler<StopVoiceWakeCommand, ErrorOr<Success>>
{
    private readonly IPorcupineDetector _porcupineDetector;
    private readonly IVoicePushToTalkService _pushToTalk;
    private readonly ILogger<StopVoiceWakeHandler> _logger;

    public StopVoiceWakeHandler(
        IPorcupineDetector porcupineDetector,
        IVoicePushToTalkService pushToTalk,
        ILogger<StopVoiceWakeHandler> logger)
    {
        _porcupineDetector = porcupineDetector;
        _pushToTalk = pushToTalk;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(StopVoiceWakeCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Stopping VoiceWake pipeline");
        _pushToTalk.SetEnabled(false);
        await _porcupineDetector.StopAsync(ct);
        return Result.Success;
    }
}
