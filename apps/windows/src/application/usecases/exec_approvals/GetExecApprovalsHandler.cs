using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

[UseCase("UC-022")]
public sealed record GetExecApprovalsQuery : IRequest<ErrorOr<ExecApprovalsSnapshot>>;

internal sealed class GetExecApprovalsHandler : IRequestHandler<GetExecApprovalsQuery, ErrorOr<ExecApprovalsSnapshot>>
{
    private readonly IExecApprovalsRepository _repo;

    public GetExecApprovalsHandler(IExecApprovalsRepository repo)
    {
        _repo = repo;
    }

    public async Task<ErrorOr<ExecApprovalsSnapshot>> Handle(GetExecApprovalsQuery _, CancellationToken ct)
    {
        return await _repo.GetSnapshotAsync(ct);
    }
}
