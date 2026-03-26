using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

[UseCase("UC-025")]
public sealed record StartIpcServerCommand : IRequest<ErrorOr<Success>>;

internal sealed class StartIpcServerHandler : IRequestHandler<StartIpcServerCommand, ErrorOr<Success>>
{
    private readonly IExecApprovalIpc _ipc;
    private readonly IExecApprovalPromptHandler _promptHandler;
    private readonly ILogger<StartIpcServerHandler> _logger;

    public StartIpcServerHandler(
        IExecApprovalIpc ipc,
        IExecApprovalPromptHandler promptHandler,
        ILogger<StartIpcServerHandler> logger)
    {
        _ipc           = ipc;
        _promptHandler = promptHandler;
        _logger        = logger;
    }

    public async Task<ErrorOr<Success>> Handle(StartIpcServerCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Starting exec approval IPC server");
        var result = await _ipc.StartServerAsync(
            frame => _promptHandler.PromptAsync(frame, ct), ct);
        if (result.IsError)
            return Error.Failure("EA.IPC_START_FAILED", result.FirstError.Description);
        return Result.Success;
    }
}
