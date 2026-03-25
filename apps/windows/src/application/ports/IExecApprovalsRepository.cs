using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Persists exec-approval configuration to and from durable storage.
/// </summary>
public interface IExecApprovalsRepository
{
    // Simplified load for EvaluateExecRequestHandler; GAP-047 will replace with ResolveAsync.
    Task<ExecApprovalConfig> LoadAsync(CancellationToken ct);

    Task<ExecApprovalsResolved> ResolveAsync(string? agentId, CancellationToken ct);
    Task<ExecApprovalsSnapshot> GetSnapshotAsync(CancellationToken ct);

    // Applies an incoming file from the gateway, with hash-based conflict detection.
    // Throws InvalidOperationException on hash mismatch (conflict).
    Task ApplyFileAsync(ExecApprovalsFile file, string? baseHash, CancellationToken ct);
}
