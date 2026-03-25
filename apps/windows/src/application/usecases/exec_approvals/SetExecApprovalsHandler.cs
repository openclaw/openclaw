using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

[UseCase("UC-023")]
public sealed record SetExecApprovalsCommand(ExecApprovalsFile File, string? BaseHash)
    : IRequest<ErrorOr<ExecApprovalsSnapshot>>;

internal sealed class SetExecApprovalsHandler : IRequestHandler<SetExecApprovalsCommand, ErrorOr<ExecApprovalsSnapshot>>
{
    private readonly IExecApprovalsRepository _repo;
    private readonly ILogger<SetExecApprovalsHandler> _logger;

    public SetExecApprovalsHandler(IExecApprovalsRepository repo, ILogger<SetExecApprovalsHandler> logger)
    {
        _repo = repo;
        _logger = logger;
    }

    public async Task<ErrorOr<ExecApprovalsSnapshot>> Handle(SetExecApprovalsCommand cmd, CancellationToken ct)
    {
        Guard.Against.Null(cmd.File, nameof(cmd.File));

        try
        {
            await _repo.ApplyFileAsync(cmd.File, cmd.BaseHash, ct);
        }
        catch (InvalidOperationException ex)
        {
            // Hash mismatch — client must reload before retrying.
            return Error.Conflict("EXEC_APPROVALS_CONFLICT", ex.Message);
        }

        _logger.LogInformation("system.execApprovals.set applied");
        return await _repo.GetSnapshotAsync(ct);
    }
}
