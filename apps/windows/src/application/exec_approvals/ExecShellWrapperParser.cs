namespace OpenClawWindows.Application.ExecApprovals;

// Detects shell wrapper invocations (bash/sh/cmd/powershell) and extracts the inline -c payload.
internal static class ExecShellWrapperParser
{
    internal sealed record ParsedShellWrapper(bool IsWrapper, string? Command)
    {
        internal static readonly ParsedShellWrapper NotWrapper = new(false, null);
    }

    private enum Kind { Posix, Cmd, Powershell }

    private sealed record WrapperSpec(Kind Kind, HashSet<string> Names);

    private static readonly HashSet<string> PosixInlineFlags =
        new(StringComparer.OrdinalIgnoreCase) { "-lc", "-c", "--command" };

    private static readonly HashSet<string> PowerShellInlineFlags =
        new(StringComparer.OrdinalIgnoreCase) { "-c", "-command", "--command" };

    private static readonly WrapperSpec[] Specs =
    [
        new(Kind.Posix,      new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "ash", "sh", "bash", "zsh", "dash", "ksh", "fish" }),
        new(Kind.Cmd,        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "cmd.exe", "cmd" }),
        new(Kind.Powershell, new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "powershell", "powershell.exe", "pwsh", "pwsh.exe" }),
    ];

    internal static ParsedShellWrapper Extract(IReadOnlyList<string> command, string? rawCommand)
    {
        var trimmedRaw = rawCommand?.Trim() ?? string.Empty;
        var preferredRaw = trimmedRaw.Length == 0 ? null : trimmedRaw;
        return ExtractInner(command, preferredRaw, 0);
    }

    private static ParsedShellWrapper ExtractInner(
        IReadOnlyList<string> command, string? preferredRaw, int depth)
    {
        if (depth >= ExecEnvInvocationUnwrapper.MaxWrapperDepth)
            return ParsedShellWrapper.NotWrapper;
        if (command.Count == 0) return ParsedShellWrapper.NotWrapper;

        var token0 = command[0].Trim();
        if (token0.Length == 0) return ParsedShellWrapper.NotWrapper;

        var base0 = ExecCommandToken.BasenameLower(token0);

        // Recursively unwrap `env ... SHELL` patterns.
        if (base0 == "env")
        {
            var unwrapped = ExecEnvInvocationUnwrapper.Unwrap(command);
            if (unwrapped == null) return ParsedShellWrapper.NotWrapper;
            return ExtractInner(unwrapped, preferredRaw, depth + 1);
        }

        var spec = Array.Find(Specs, s => s.Names.Contains(base0));
        if (spec is null) return ParsedShellWrapper.NotWrapper;

        var payload = ExtractPayload(command, spec);
        if (payload is null) return ParsedShellWrapper.NotWrapper;

        // Prefer rawCommand when provided
        return new ParsedShellWrapper(true, preferredRaw ?? payload);
    }

    private static string? ExtractPayload(IReadOnlyList<string> command, WrapperSpec spec) =>
        spec.Kind switch
        {
            Kind.Posix      => ExtractPosixInlineCommand(command),
            Kind.Cmd        => ExtractCmdInlineCommand(command),
            Kind.Powershell => ExtractPowerShellInlineCommand(command),
            _               => null,
        };

    private static string? ExtractPosixInlineCommand(IReadOnlyList<string> command)
    {
        if (command.Count < 2) return null;
        var flag = command[1].Trim();
        if (!PosixInlineFlags.Contains(flag)) return null;
        if (command.Count < 3) return null;
        var payload = command[2].Trim();
        return payload.Length == 0 ? null : payload;
    }

    private static string? ExtractCmdInlineCommand(IReadOnlyList<string> command)
    {
        int flagIdx = -1;
        for (int i = 1; i < command.Count; i++)
        {
            if (string.Equals(command[i].Trim(), "/c", StringComparison.OrdinalIgnoreCase))
            {
                flagIdx = i;
                break;
            }
        }
        if (flagIdx < 0) return null;
        var tail = string.Join(" ", command.Skip(flagIdx + 1)).Trim();
        return tail.Length == 0 ? null : tail;
    }

    private static string? ExtractPowerShellInlineCommand(IReadOnlyList<string> command)
    {
        for (int i = 1; i < command.Count; i++)
        {
            var token = command[i].Trim().ToLowerInvariant();
            if (token.Length == 0) continue;
            if (token == "--") break;
            if (PowerShellInlineFlags.Contains(token))
            {
                if (i + 1 >= command.Count) return null;
                var payload = command[i + 1].Trim();
                return payload.Length == 0 ? null : payload;
            }
        }
        return null;
    }
}
