using System.Text.RegularExpressions;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

// Validates and normalizes a system.run command argv before approval evaluation.
// ⚠️ SECURITY-CRITICAL: this is the anti-injection gate for shell multiplexers and env wrappers.
internal static class ExecSystemRunCommandValidator
{
    internal sealed record ResolvedCommand(string DisplayCommand);

    internal abstract record ValidationResult
    {
        internal sealed record Ok(ResolvedCommand Resolved) : ValidationResult;
        internal sealed record Invalid(string Message) : ValidationResult;
    }

    // Sets mirror the exact Swift constant declarations — values are already lowercase
    private static readonly HashSet<string> ShellWrapperNames =
        new(StringComparer.OrdinalIgnoreCase)
        { "ash", "bash", "cmd", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "zsh" };

    private static readonly HashSet<string> PosixOrPowerShellInlineWrapperNames =
        new(StringComparer.OrdinalIgnoreCase)
        { "ash", "bash", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "zsh" };

    private static readonly HashSet<string> ShellMultiplexerWrapperNames =
        new(StringComparer.OrdinalIgnoreCase) { "busybox", "toybox" };

    private static readonly HashSet<string> PosixInlineCommandFlags =
        new(StringComparer.OrdinalIgnoreCase) { "-lc", "-c", "--command" };

    private static readonly HashSet<string> PowerShellInlineCommandFlags =
        new(StringComparer.OrdinalIgnoreCase) { "-c", "-command", "--command" };

    private static readonly Regex EnvAssignmentPattern =
        new(@"^[A-Za-z_][A-Za-z0-9_]*=", RegexOptions.Compiled);

    private sealed record EnvUnwrapResult(IReadOnlyList<string> Argv, bool UsesModifiers);
    private sealed record InlineCommandTokenMatch(int TokenIndex, string? InlineCommand);

    internal static ValidationResult Resolve(IReadOnlyList<string> command, string? rawCommand)
    {
        var normalizedRaw = NormalizeRaw(rawCommand);
        var shell = ExecShellWrapperParser.Extract(command, null);
        var shellCommand = shell.IsWrapper ? TrimmedNonEmpty(shell.Command) : null;

        var envManipulation    = HasEnvManipulationBeforeShellWrapper(command);
        var positionalCarrier  = HasTrailingPositionalArgvAfterInlineCommand(command);
        var mustBindToFullArgv = envManipulation || positionalCarrier;

        var inferred         = shellCommand is not null && !mustBindToFullArgv
            ? shellCommand
            : ExecCommandFormatter.DisplayString(command);
        var fullArgvDisplay  = ExecCommandFormatter.DisplayString(command);

        // Accept rawCommand if it matches either the extracted inline payload or the canonical full argv.
        // displayCommand is always the full argv so the user sees the complete command (security: no hidden shell wrapper).
        if (normalizedRaw is not null && normalizedRaw != inferred && normalizedRaw != fullArgvDisplay)
            return new ValidationResult.Invalid("INVALID_REQUEST: rawCommand does not match command");

        return new ValidationResult.Ok(new ResolvedCommand(fullArgvDisplay));
    }

    private static string? NormalizeRaw(string? rawCommand)
    {
        var trimmed = rawCommand?.Trim() ?? string.Empty;
        return trimmed.Length == 0 ? null : trimmed;
    }

    private static string? TrimmedNonEmpty(string? value)
    {
        var trimmed = value?.Trim() ?? string.Empty;
        return trimmed.Length == 0 ? null : trimmed;
    }

    // Strips path and .exe suffix, returns lowercase
    private static string NormalizeExecutableToken(string token)
    {
        var base0 = ExecCommandToken.BasenameLower(token);
        return base0.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? base0[..^4] : base0;
    }

    private static bool IsEnvAssignment(string token) => EnvAssignmentPattern.IsMatch(token);

    private static bool HasEnvInlineValuePrefix(string lowerToken) =>
        ExecEnvOptions.InlineValuePrefixes.Any(lowerToken.StartsWith);

    // Like ExecEnvInvocationUnwrapper.Unwrap but also tracks whether any env modifiers were seen.
    private static EnvUnwrapResult? UnwrapEnvInvocationWithMetadata(IReadOnlyList<string> argv)
    {
        int  idx                = 1;
        bool expectsOptionValue = false;
        bool usesModifiers      = false;

        while (idx < argv.Count)
        {
            var token = argv[idx].Trim();
            if (token.Length == 0) { idx++; continue; }

            if (expectsOptionValue) { expectsOptionValue = false; usesModifiers = true; idx++; continue; }

            if (token == "--" || token == "-") { idx++; break; }

            if (IsEnvAssignment(token)) { usesModifiers = true; idx++; continue; }

            if (!token.StartsWith('-') || token == "-") break;

            var lower = token.ToLowerInvariant();
            var flag  = lower.Split('=', 2)[0];

            if (ExecEnvOptions.FlagOnly.Contains(flag))  { usesModifiers = true; idx++; continue; }
            if (ExecEnvOptions.WithValue.Contains(flag))
            {
                usesModifiers = true;
                if (!lower.Contains('=')) expectsOptionValue = true;
                idx++;
                continue;
            }
            if (HasEnvInlineValuePrefix(lower)) { usesModifiers = true; idx++; continue; }

            return null; // Unknown flag — fail safely
        }

        if (expectsOptionValue) return null;
        if (idx >= argv.Count)  return null;

        return new EnvUnwrapResult(argv.Skip(idx).ToList(), usesModifiers);
    }

    private static IReadOnlyList<string>? UnwrapShellMultiplexerInvocation(IReadOnlyList<string> argv)
    {
        var token0 = TrimmedNonEmpty(argv.Count > 0 ? argv[0] : null);
        if (token0 is null) return null;

        var wrapper = NormalizeExecutableToken(token0);
        if (!ShellMultiplexerWrapperNames.Contains(wrapper)) return null;

        int appletIndex = 1;
        if (appletIndex < argv.Count && argv[appletIndex].Trim() == "--") appletIndex++;
        if (appletIndex >= argv.Count) return null;

        var applet = argv[appletIndex].Trim();
        if (applet.Length == 0) return null;

        var normalizedApplet = NormalizeExecutableToken(applet);
        if (!ShellWrapperNames.Contains(normalizedApplet)) return null;

        return argv.Skip(appletIndex).ToList();
    }

    private static bool HasEnvManipulationBeforeShellWrapper(
        IReadOnlyList<string> argv,
        int  depth               = 0,
        bool envManipulationSeen = false)
    {
        if (depth >= ExecEnvInvocationUnwrapper.MaxWrapperDepth) return false;

        var token0 = TrimmedNonEmpty(argv.Count > 0 ? argv[0] : null);
        if (token0 is null) return false;

        var normalized = NormalizeExecutableToken(token0);

        if (normalized == "env")
        {
            var envUnwrap = UnwrapEnvInvocationWithMetadata(argv);
            if (envUnwrap is null) return false;
            return HasEnvManipulationBeforeShellWrapper(
                envUnwrap.Argv, depth + 1, envManipulationSeen || envUnwrap.UsesModifiers);
        }

        var multiplexer = UnwrapShellMultiplexerInvocation(argv);
        if (multiplexer is not null)
            return HasEnvManipulationBeforeShellWrapper(multiplexer, depth + 1, envManipulationSeen);

        if (!ShellWrapperNames.Contains(normalized)) return false;
        if (ExtractShellInlinePayload(argv, normalized) is null) return false;

        return envManipulationSeen;
    }

    private static bool HasTrailingPositionalArgvAfterInlineCommand(IReadOnlyList<string> argv)
    {
        var wrapperArgv = UnwrapShellWrapperArgv(argv);
        var token0 = TrimmedNonEmpty(wrapperArgv.Count > 0 ? wrapperArgv[0] : null);
        if (token0 is null) return false;

        var wrapper = NormalizeExecutableToken(token0);
        if (!PosixOrPowerShellInlineWrapperNames.Contains(wrapper)) return false;

        bool isPowerShell = wrapper is "powershell" or "pwsh";
        var inlineIdx = isPowerShell
            ? ResolveInlineCommandTokenIndex(wrapperArgv, PowerShellInlineCommandFlags, allowCombinedC: false)
            : ResolveInlineCommandTokenIndex(wrapperArgv, PosixInlineCommandFlags,      allowCombinedC: true);

        if (inlineIdx is null) return false;

        int start = inlineIdx.Value + 1;
        if (start >= wrapperArgv.Count) return false;

        return wrapperArgv.Skip(start).Any(t => t.Trim().Length > 0);
    }

    // Strips env wrappers (no-modifier only) and shell multiplexers to reach the inner shell argv.
    private static IReadOnlyList<string> UnwrapShellWrapperArgv(IReadOnlyList<string> argv)
    {
        var current = argv;
        for (int i = 0; i < ExecEnvInvocationUnwrapper.MaxWrapperDepth; i++)
        {
            var token0 = TrimmedNonEmpty(current.Count > 0 ? current[0] : null);
            if (token0 is null) break;

            var normalized = NormalizeExecutableToken(token0);
            if (normalized == "env")
            {
                var envUnwrap = UnwrapEnvInvocationWithMetadata(current);
                // Only strip env when it carries no modifiers
                if (envUnwrap is null || envUnwrap.UsesModifiers || envUnwrap.Argv.Count == 0) break;
                current = envUnwrap.Argv;
                continue;
            }

            var multiplexer = UnwrapShellMultiplexerInvocation(current);
            if (multiplexer is not null) { current = multiplexer; continue; }

            break;
        }
        return current;
    }

    private static InlineCommandTokenMatch? FindInlineCommandTokenMatch(
        IReadOnlyList<string> argv,
        HashSet<string>       flags,
        bool                  allowCombinedC)
    {
        int idx = 1;
        while (idx < argv.Count)
        {
            var token = argv[idx].Trim();
            if (token.Length == 0) { idx++; continue; }

            var lower = token.ToLowerInvariant();
            if (lower == "--") break;

            if (flags.Contains(lower)) return new InlineCommandTokenMatch(idx, null);

            if (allowCombinedC)
            {
                var offset = CombinedCommandInlineOffset(token);
                if (offset is not null)
                {
                    var inline = token[offset.Value..].Trim();
                    return new InlineCommandTokenMatch(idx, inline.Length == 0 ? null : inline);
                }
            }
            idx++;
        }
        return null;
    }

    private static int? ResolveInlineCommandTokenIndex(
        IReadOnlyList<string> argv,
        HashSet<string>       flags,
        bool                  allowCombinedC)
    {
        var match = FindInlineCommandTokenMatch(argv, flags, allowCombinedC);
        if (match is null) return null;
        if (match.InlineCommand is not null) return match.TokenIndex;
        int nextIndex = match.TokenIndex + 1;
        return nextIndex < argv.Count ? nextIndex : null;
    }

    // Returns the character offset within `token` where the inline command starts for
    // combined POSIX flags like "-lc" (offset=2+1=3) or "-xc" (offset=2+1=3).
    private static int? CombinedCommandInlineOffset(string token)
    {
        var chars = token.ToLowerInvariant().ToCharArray();
        if (chars.Length < 2 || chars[0] != '-' || chars[1] == '-') return null;
        // No internal dashes after the leading one
        if (chars.Skip(1).Contains('-')) return null;
        var commandIndex = Array.IndexOf(chars, 'c', 1);
        if (commandIndex <= 0) return null;
        return commandIndex + 1;
    }

    private static string? ExtractShellInlinePayload(IReadOnlyList<string> argv, string normalizedWrapper)
    {
        if (normalizedWrapper == "cmd")
            return ExtractCmdInlineCommand(argv);
        if (normalizedWrapper is "powershell" or "pwsh")
            return ExtractInlineCommandByFlags(argv, PowerShellInlineCommandFlags, allowCombinedC: false);
        return ExtractInlineCommandByFlags(argv, PosixInlineCommandFlags, allowCombinedC: true);
    }

    private static string? ExtractInlineCommandByFlags(
        IReadOnlyList<string> argv,
        HashSet<string>       flags,
        bool                  allowCombinedC)
    {
        var match = FindInlineCommandTokenMatch(argv, flags, allowCombinedC);
        if (match is null) return null;
        if (match.InlineCommand is not null) return match.InlineCommand;
        int nextIndex = match.TokenIndex + 1;
        return TrimmedNonEmpty(nextIndex < argv.Count ? argv[nextIndex] : null);
    }

    private static string? ExtractCmdInlineCommand(IReadOnlyList<string> argv)
    {
        int flagIdx = -1;
        for (int i = 1; i < argv.Count; i++)
        {
            var t = argv[i].Trim().ToLowerInvariant();
            if (t == "/c" || t == "/k") { flagIdx = i; break; }
        }
        if (flagIdx < 0) return null;
        var payload = string.Join(" ", argv.Skip(flagIdx + 1)).Trim();
        return payload.Length == 0 ? null : payload;
    }
}
