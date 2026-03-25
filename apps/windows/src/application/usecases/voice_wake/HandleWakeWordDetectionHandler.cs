using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.TalkMode;
using OpenClawWindows.Domain.VoiceWake.Events;

namespace OpenClawWindows.Application.VoiceWake;

[UseCase("UC-032")]
public sealed record HandleWakeWordDetectionCommand(DateTimeOffset DetectedAt) : IRequest<ErrorOr<Success>>;

internal sealed class HandleWakeWordDetectionHandler
    : IRequestHandler<HandleWakeWordDetectionCommand, ErrorOr<Success>>
{
    private readonly IMediator _mediator;
    private readonly IAuditLogger _audit;
    private readonly ILogger<HandleWakeWordDetectionHandler> _logger;

    public HandleWakeWordDetectionHandler(IMediator mediator, IAuditLogger audit,
        ILogger<HandleWakeWordDetectionHandler> logger)
    {
        _mediator = mediator;
        _audit = audit;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(HandleWakeWordDetectionCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Wake word detected at {DetectedAt}", cmd.DetectedAt);

        await _mediator.Publish(new WakeWordDetected { DetectedAt = cmd.DetectedAt }, ct);

        var startResult = await _mediator.Send(new StartTalkModeCommand(), ct);
        if (startResult.IsError)
        {
            _logger.LogWarning("TalkMode failed after wake word: {Error}", startResult.FirstError.Description);
            return Error.Failure("VW.TALK_MODE_FAILED", startResult.FirstError.Description);
        }

        await _audit.LogAsync("voice_wake.detected", "microphone", true, null, ct);
        return Result.Success;
    }
}
