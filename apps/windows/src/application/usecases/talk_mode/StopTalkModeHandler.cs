using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.TalkMode;
using OpenClawWindows.Domain.TalkMode.Events;

namespace OpenClawWindows.Application.TalkMode;

[UseCase("UC-029")]
public sealed record StopTalkModeCommand(string Reason = "user_request") : IRequest<ErrorOr<Success>>;

internal sealed class StopTalkModeHandler : IRequestHandler<StopTalkModeCommand, ErrorOr<Success>>
{
    private readonly ITalkModeRuntime _runtime;
    private readonly IMediator _mediator;
    private readonly ILogger<StopTalkModeHandler> _logger;

    public StopTalkModeHandler(ITalkModeRuntime runtime, IMediator mediator,
        ILogger<StopTalkModeHandler> logger)
    {
        _runtime = runtime;
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(StopTalkModeCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("TalkMode stopping reason={Reason}", cmd.Reason);
        await _runtime.SetEnabledAsync(false);
        await _mediator.Publish(new TalkModeEnded { Reason = cmd.Reason }, ct);
        return Result.Success;
    }
}
