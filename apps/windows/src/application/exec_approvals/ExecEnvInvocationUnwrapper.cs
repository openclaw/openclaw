using System.Text.RegularExpressions;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

// Strips `env` wrapper invocations so the true executable can be resolved.
internal static class ExecEnvInvocationUnwrapper
{
    // Tunables
    internal const int MaxWrapperDepth = 4;

    private static readonly Regex EnvAssignmentPattern =
        new(@"^[A-Za-z_][A-Za-z0-9_]*=", RegexOptions.Compiled);

    // Strips `env [OPTIONS] [VAR=VAL...] COMMAND [ARGS...]`, returning COMMAND + ARGS.
    // Returns null when the command cannot be safely unwrapped (unknown flag, etc.).
    internal static IReadOnlyList<string>? Unwrap(IReadOnlyList<string> command)
    {
        int idx = 1;
        bool expectsOptionValue = false;
        while (idx < command.Count)
        {
            var token = command[idx].Trim();
            if (token.Length == 0) { idx++; continue; }

            if (expectsOptionValue) { expectsOptionValue = false; idx++; continue; }

            if (token == "--" || token == "-") { idx++; break; }

            if (EnvAssignmentPattern.IsMatch(token)) { idx++; continue; }

            if (token.StartsWith('-') && token != "-")
            {
                var lower = token.ToLowerInvariant();
                var flag = lower.Split('=', 2)[0];
                if (ExecEnvOptions.FlagOnly.Contains(flag)) { idx++; continue; }
                if (ExecEnvOptions.WithValue.Contains(flag))
                {
                    // -u=value form already contains value; -u value form needs next token.
                    if (!lower.Contains('=')) expectsOptionValue = true;
                    idx++;
                    continue;
                }
                // Inline-value prefixes that do not need a separate next token.
                if (ExecEnvOptions.InlineValuePrefixes.Any(p => lower.StartsWith(p)))
                {
                    idx++;
                    continue;
                }
                return null; // Unknown flag — fail safely.
            }

            break; // Executable token found.
        }

        if (idx >= command.Count) return null;
        return command.Skip(idx).ToList();
    }

    // Iteratively strips env wrappers for the purpose of executable resolution only.
    internal static IReadOnlyList<string> UnwrapDispatchWrappersForResolution(IReadOnlyList<string> command)
    {
        var current = command;
        int depth = 0;
        while (depth < MaxWrapperDepth)
        {
            if (current.Count == 0) break;
            var token = current[0].Trim();
            if (token.Length == 0) break;
            if (ExecCommandToken.BasenameLower(token) != "env") break;
            var unwrapped = Unwrap(current);
            if (unwrapped == null || unwrapped.Count == 0) break;
            current = unwrapped;
            depth++;
        }
        return current;
    }
}
