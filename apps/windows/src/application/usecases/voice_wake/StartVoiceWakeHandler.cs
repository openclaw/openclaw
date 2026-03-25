using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Application.VoiceWake;

[UseCase("UC-031")]
public sealed record StartVoiceWakeCommand : IRequest<ErrorOr<Success>>;

internal sealed class StartVoiceWakeHandler : IRequestHandler<StartVoiceWakeCommand, ErrorOr<Success>>
{
    private readonly IPorcupineDetector _porcupineDetector;
    private readonly IAudioCaptureDevice _audioCaptureDevice;
    private readonly IVoicePushToTalkService _pushToTalk;
    private readonly ILogger<StartVoiceWakeHandler> _logger;

    public StartVoiceWakeHandler(
        IPorcupineDetector porcupineDetector,
        IAudioCaptureDevice audioCaptureDevice,
        IVoicePushToTalkService pushToTalk,
        ILogger<StartVoiceWakeHandler> logger)
    {
        _porcupineDetector = porcupineDetector;
        _audioCaptureDevice = audioCaptureDevice;
        _pushToTalk = pushToTalk;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(StartVoiceWakeCommand cmd, CancellationToken ct)
    {
        var permitted = await _audioCaptureDevice.IsPermissionGrantedAsync(ct);
        if (!permitted)
            return Error.Forbidden("PERMISSION_MISSING", "Microphone permission required for voice wake");

        // Enable PTT hotkey monitor — independent of Porcupine wake-word availability.
        _pushToTalk.SetEnabled(true);

        // SPIKE-004: Porcupine SDK pending; non-fatal so PTT still activates.
        var result = await _porcupineDetector.StartAsync(ct);
        if (result.IsError)
            _logger.LogWarning("Wake-word detector unavailable: {Msg}", result.FirstError.Description);

        _logger.LogInformation("VoiceWake pipeline started");
        return Result.Success;
    }
}
