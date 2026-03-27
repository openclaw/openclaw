using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Shell command executor with injection-safe argument handling.
/// Implemented by ShellExecutorAdapter (System.Diagnostics.Process, ArgumentList not ArgumentString).
/// </summary>
public interface IShellExecutor
{
    Task<ErrorOr<ShellCommandResult>> RunAsync(string executable, string[] args,
        int? timeoutMs, CancellationToken ct,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? env = null);

    Task<ExecutablePath> WhichAsync(string executableName, CancellationToken ct);
}
