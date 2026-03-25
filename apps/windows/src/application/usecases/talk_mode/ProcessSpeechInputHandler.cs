using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.TalkMode;

namespace OpenClawWindows.Application.TalkMode;

[UseCase("UC-027")]
public sealed record ProcessSpeechInputCommand(string RecognizedText, bool IsFinal)
    : IRequest<ErrorOr<Success>>;

// External callers (e.g. NodeInvokeDispatcher "talk.inject" route) can inject
// a transcript directly into the runtime, bypassing STT.
// The runtime itself routes STT callbacks internally — this handler is for external injection only.
internal sealed class ProcessSpeechInputHandler : IRequestHandler<ProcessSpeechInputCommand, ErrorOr<Success>>
{
    private readonly ITalkModeRuntime _runtime;
    private readonly ILogger<ProcessSpeechInputHandler> _logger;

    public ProcessSpeechInputHandler(ITalkModeRuntime runtime,
        ILogger<ProcessSpeechInputHandler> logger)
    {
        _runtime = runtime;
        _logger = logger;
    }

    public Task<ErrorOr<Success>> Handle(ProcessSpeechInputCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.RecognizedText, nameof(cmd.RecognizedText));

        // Partial transcripts are handled internally by the runtime's silence loop.
        if (!cmd.IsFinal)
            return Task.FromResult<ErrorOr<Success>>(Result.Success);

        _logger.LogDebug("TalkMode external inject: {Len} chars", cmd.RecognizedText.Length);
        // Runtime is currently listening or idle; external injection is informational only.
        // Full chatSend → chatHistory → TTS pipeline runs inside WindowsTalkModeRuntime.
        return Task.FromResult<ErrorOr<Success>>(Result.Success);
    }
}
