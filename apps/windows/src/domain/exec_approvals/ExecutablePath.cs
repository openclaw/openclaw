namespace OpenClawWindows.Domain.ExecApprovals;

// system.which response
public sealed record ExecutablePath
{
    public string ExecutableName { get; }
    public string? FullPath { get; }
    public bool IsFound => FullPath is not null;

    private ExecutablePath(string executableName, string? fullPath)
    {
        ExecutableName = executableName;
        FullPath = fullPath;
    }

    public static ExecutablePath Found(string fullPath, string executableName)
    {
        Guard.Against.NullOrWhiteSpace(fullPath, nameof(fullPath));
        Guard.Against.NullOrWhiteSpace(executableName, nameof(executableName));
        return new(executableName, fullPath);
    }

    public static ExecutablePath NotFound(string executableName)
    {
        Guard.Against.NullOrWhiteSpace(executableName, nameof(executableName));
        return new(executableName, null);
    }
}
