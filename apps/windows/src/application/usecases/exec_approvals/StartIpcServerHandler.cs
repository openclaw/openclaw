using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

[UseCase("UC-025")]
public sealed record StartIpcServerCommand : IRequest<ErrorOr<Success>>;

internal sealed class StartIpcServerHandler : IRequestHandler<StartIpcServerCommand, ErrorOr<Success>>
{
    private readonly IExecApprovalIpc _ipc;
    private readonly ILogger<StartIpcServerHandler> _logger;

    public StartIpcServerHandler(IExecApprovalIpc ipc, ILogger<StartIpcServerHandler> logger)
    {
        _ipc = ipc;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(StartIpcServerCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Starting exec approval IPC server");
        var result = await _ipc.StartServerAsync(ct);
        if (result.IsError)
            return Error.Failure("EA.IPC_START_FAILED", result.FirstError.Description);
        return Result.Success;
    }
}
