using OpenClawWindows.Application.Behaviors;

namespace OpenClawWindows.Application.TalkMode;

[UseCase("UC-028")]
public sealed record HandleSttErrorCommand(string ErrorCode, string Message) : IRequest<ErrorOr<Success>>;

internal sealed class HandleSttErrorHandler : IRequestHandler<HandleSttErrorCommand, ErrorOr<Success>>
{
    // Recoverable STT error codes — restart STT; all others trigger TalkMode stop
    private static readonly HashSet<string> RecoverableCodes = ["NO_SPEECH", "AUDIO_CAPTURE_LOSS"];

    private readonly ISpeechRecognizer _speechRecognizer;
    private readonly IMediator _mediator;
    private readonly ILogger<HandleSttErrorHandler> _logger;

    public HandleSttErrorHandler(ISpeechRecognizer speechRecognizer, IMediator mediator,
        ILogger<HandleSttErrorHandler> logger)
    {
        _speechRecognizer = speechRecognizer;
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(HandleSttErrorCommand cmd, CancellationToken ct)
    {
        _logger.LogWarning("STT error code={Code} message={Message}", cmd.ErrorCode, cmd.Message);

        if (RecoverableCodes.Contains(cmd.ErrorCode))
        {
            var restartResult = await _speechRecognizer.RestartAsync(ct);
            if (restartResult.IsError)
            {
                _logger.LogError("STT restart failed — stopping TalkMode");
                await _mediator.Send(new StopTalkModeCommand("stt_restart_failed"), ct);
                return Error.Failure("TALK.RESTART_FAILED", restartResult.FirstError.Description);
            }
            return Result.Success;
        }

        _logger.LogWarning("Unrecoverable STT error — stopping TalkMode");
        await _mediator.Send(new StopTalkModeCommand(cmd.ErrorCode), ct);
        return Result.Success;
    }
}
