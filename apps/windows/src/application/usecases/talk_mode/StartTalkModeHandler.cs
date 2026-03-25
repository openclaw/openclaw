using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.TalkMode;
using OpenClawWindows.Domain.TalkMode.Events;

namespace OpenClawWindows.Application.TalkMode;

[UseCase("UC-026")]
public sealed record StartTalkModeCommand(TalkModeConfig? Config = null) : IRequest<ErrorOr<Success>>;

internal sealed class StartTalkModeHandler : IRequestHandler<StartTalkModeCommand, ErrorOr<Success>>
{
    private readonly ITalkModeRuntime _runtime;
    private readonly IMediator _mediator;
    private readonly ILogger<StartTalkModeHandler> _logger;

    public StartTalkModeHandler(ITalkModeRuntime runtime, IMediator mediator,
        ILogger<StartTalkModeHandler> logger)
    {
        _runtime = runtime;
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(StartTalkModeCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("TalkMode starting");
        await _runtime.SetEnabledAsync(true);
        await _mediator.Publish(new TalkModeStarted(), ct);
        return Result.Success;
    }
}
