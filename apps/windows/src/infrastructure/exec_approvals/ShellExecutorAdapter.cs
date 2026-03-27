using System.Diagnostics;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Infrastructure.ExecApprovals;

// Shell command execution. Security: always uses ArgumentList (NOT ArgumentString)
// to prevent injection
internal sealed class ShellExecutorAdapter : IShellExecutor
{
    private readonly ILogger<ShellExecutorAdapter> _logger;

    // Tunables
    private const int DefaultTimeoutMs = 30_000; // 30 s — matches macOS default

    public ShellExecutorAdapter(ILogger<ShellExecutorAdapter> logger)
    {
        _logger = logger;
    }

    public async Task<ErrorOr<ShellCommandResult>> RunAsync(
        string executable, string[] args, int? timeoutMs, CancellationToken ct,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? env = null)
    {
        var sw = Stopwatch.StartNew();
        var psi = new ProcessStartInfo
        {
            FileName = executable,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = cwd ?? string.Empty,
        };

        if (env is not null)
            foreach (var (k, v) in env)
                psi.Environment[k] = v;

        // Use ArgumentList — never ArgumentString — to prevent shell injection
        foreach (var arg in args)
            psi.ArgumentList.Add(arg);

        using var process = new Process { StartInfo = psi };
        process.Start();

        var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = process.StandardError.ReadToEndAsync(ct);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeoutMs ?? DefaultTimeoutMs);

        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            process.Kill(entireProcessTree: true);
            return Error.Failure("EXEC_TIMEOUT", $"Command timed out after {timeoutMs ?? DefaultTimeoutMs}ms");
        }

        sw.Stop();

        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        _logger.LogDebug("Exec '{Exe}' exit={Code} ms={Ms}", executable, process.ExitCode, sw.ElapsedMilliseconds);

        return ShellCommandResult.Create(
            exitCode: process.ExitCode,
            stdout: stdout,
            stderr: stderr,
            durationMs: (int)sw.ElapsedMilliseconds,
            command: $"{executable} {string.Join(' ', args)}");
    }

    public async Task<ExecutablePath> WhichAsync(string executableName, CancellationToken ct)
    {
        // On Windows, use 'where.exe' (equivalent to Unix 'which')
        var result = await RunAsync("where.exe", [executableName], timeoutMs: 5_000, ct);

        if (result.IsError || result.Value.ExitCode != 0)
            return ExecutablePath.NotFound(executableName);

        var firstLine = result.Value.Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault()?.Trim();

        return firstLine is { Length: > 0 }
            ? ExecutablePath.Found(firstLine, executableName)
            : ExecutablePath.NotFound(executableName);
    }
}
