using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Shows an exec-approval dialog when the named pipe server receives a prompt request.
/// </summary>
public interface IExecApprovalPromptHandler
{
    Task<bool> PromptAsync(NamedPipeFrame frame, CancellationToken ct);
}
