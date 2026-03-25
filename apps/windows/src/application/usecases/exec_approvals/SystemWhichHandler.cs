using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

[UseCase("UC-021")]
public sealed record SystemWhichQuery(string ExecutableName) : IRequest<ErrorOr<ExecutablePath>>;

internal sealed class SystemWhichHandler : IRequestHandler<SystemWhichQuery, ErrorOr<ExecutablePath>>
{
    private readonly IShellExecutor _shell;

    public SystemWhichHandler(IShellExecutor shell)
    {
        _shell = shell;
    }

    public async Task<ErrorOr<ExecutablePath>> Handle(SystemWhichQuery query, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(query.ExecutableName, nameof(query.ExecutableName));

        var result = await _shell.WhichAsync(query.ExecutableName, ct);
        return result;
    }
}
