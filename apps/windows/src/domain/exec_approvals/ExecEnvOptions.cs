namespace OpenClawWindows.Domain.ExecApprovals;

/// <summary>
/// Constants describing the option grammar of the POSIX `env` command.
/// Centralises flag/option knowledge so parsers share a single source of truth.
/// </summary>
internal static class ExecEnvOptions
{
    // Options that consume the next argument as their value (or use inline = form).
    internal static readonly HashSet<string> WithValue = new(StringComparer.Ordinal)
    {
        "-u", "--unset",
        "-c", "--chdir",
        "-s", "--split-string",
        "--default-signal",
        "--ignore-signal",
        "--block-signal",
    };

    // Options that are standalone flags (take no value at all).
    internal static readonly HashSet<string> FlagOnly = new(StringComparer.Ordinal)
    {
        "-i", "--ignore-environment",
        "-0", "--null",
    };

    // Prefixes for the inline-value form (e.g. `-uFOO` or `--unset=FOO`).
    // A token whose lowercased form starts with any of these carries its value inline.
    internal static readonly IReadOnlyList<string> InlineValuePrefixes = [
        "-u", "-c", "-s",
        "--unset=",
        "--chdir=",
        "--split-string=",
        "--default-signal=",
        "--ignore-signal=",
        "--block-signal=",
    ];
}
