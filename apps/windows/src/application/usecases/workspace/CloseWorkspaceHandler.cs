using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Settings;

namespace OpenClawWindows.Application.Workspace;

[UseCase("UC-051")]
public sealed record CloseWorkspaceCommand : IRequest<ErrorOr<Success>>;

internal sealed class CloseWorkspaceHandler : IRequestHandler<CloseWorkspaceCommand, ErrorOr<Success>>
{
    private readonly IMediator _mediator;
    private readonly ILogger<CloseWorkspaceHandler> _logger;

    public CloseWorkspaceHandler(IMediator mediator, ILogger<CloseWorkspaceHandler> logger)
    {
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(CloseWorkspaceCommand cmd, CancellationToken ct)
    {
        var settingsResult = await _mediator.Send(new GetSettingsQuery(), ct);
        if (settingsResult.IsError)
            return settingsResult.Errors;

        var settings = settingsResult.Value;
        settings.SetWorkspacePath(null);
        var saveResult = await _mediator.Send(new SaveSettingsCommand(settings), ct);
        if (saveResult.IsError)
            return saveResult.Errors;

        _logger.LogInformation("Workspace closed");
        return Result.Success;
    }
}
