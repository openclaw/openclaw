using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Settings;
using OpenClawWindows.Domain.Workspace;

namespace OpenClawWindows.Application.Workspace;

[UseCase("UC-050")]
public sealed record OpenWorkspaceCommand(string WorkspacePath) : IRequest<ErrorOr<Success>>;

internal sealed class OpenWorkspaceHandler : IRequestHandler<OpenWorkspaceCommand, ErrorOr<Success>>
{
    private readonly IMediator _mediator;
    private readonly ILogger<OpenWorkspaceHandler> _logger;

    public OpenWorkspaceHandler(IMediator mediator, ILogger<OpenWorkspaceHandler> logger)
    {
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(OpenWorkspaceCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.WorkspacePath, nameof(cmd.WorkspacePath));

        // Resolve tilde / env vars before validation
        var resolvedPath = AgentWorkspace.ResolveWorkspacePath(cmd.WorkspacePath);

        if (File.Exists(resolvedPath))
            return Error.Conflict("WS.PATH_IS_FILE", $"Workspace path points to a file: {resolvedPath}");

        var settingsResult = await _mediator.Send(new GetSettingsQuery(), ct);
        if (settingsResult.IsError)
            return settingsResult.Errors;

        var settings = settingsResult.Value;
        settings.SetWorkspacePath(resolvedPath);
        var saveResult = await _mediator.Send(new SaveSettingsCommand(settings), ct);
        if (saveResult.IsError)
            return saveResult.Errors;

        // Bootstrap workspace files if needed
        var safety = AgentWorkspace.CheckBootstrapSafety(resolvedPath);
        if (!safety.IsBlocked)
        {
            try
            {
                var agentsPath = AgentWorkspace.Bootstrap(resolvedPath);
                _logger.LogInformation("Workspace bootstrapped: {AgentsPath}", agentsPath);
            }
            catch (Exception ex)
            {
                // Non-fatal — workspace path is already persisted
                _logger.LogWarning(ex, "Failed to bootstrap workspace at {Path}", resolvedPath);
            }
        }
        else
        {
            _logger.LogInformation("Workspace bootstrap skipped: {Reason}", safety.UnsafeReason);
        }

        _logger.LogInformation("Workspace opened: {Path}", resolvedPath);
        return Result.Success;
    }
}
