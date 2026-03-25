namespace OpenClawWindows.Domain.ExecApprovals;

public sealed record ShellCommandResult
{
    public int ExitCode { get; }
    public string Stdout { get; }
    public string Stderr { get; }
    public int DurationMs { get; }
    public string Command { get; }
    public bool IsSuccess => ExitCode == 0;

    private ShellCommandResult(int exitCode, string stdout, string stderr, int durationMs, string command)
    {
        ExitCode = exitCode;
        Stdout = stdout;
        Stderr = stderr;
        DurationMs = durationMs;
        Command = command;
    }

    public static ErrorOr<ShellCommandResult> Create(int exitCode, string stdout, string stderr,
        int durationMs, string command)
    {
        Guard.Against.NullOrWhiteSpace(command, nameof(command));
        Guard.Against.Negative(durationMs, nameof(durationMs));

        return new ShellCommandResult(exitCode, stdout ?? "", stderr ?? "", durationMs, command);
    }
}
