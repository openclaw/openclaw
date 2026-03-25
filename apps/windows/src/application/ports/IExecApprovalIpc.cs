using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Named pipe IPC for exec approval prompts.
/// Implemented by NamedPipeExecApprovalAdapter (System.IO.Pipes).
/// Protocol: 4-byte LE uint32 length prefix + UTF-8 JSON (OQ-001).
/// </summary>
public interface IExecApprovalIpc
{
    Task<bool> RequestApprovalAsync(NamedPipeFrame request, CancellationToken ct);
    Task<ErrorOr<Success>> StartServerAsync(CancellationToken ct);
    Task StartListeningAsync(Func<NamedPipeFrame, Task<bool>> handler, CancellationToken ct);
}
