namespace OpenClawWindows.Application.ExecApprovals;

// Resolution of a command token to its full path, used for allowlist matching.
internal sealed record ExecCommandResolution(
    string RawExecutable,
    string? ResolvedPath,
    string ExecutableName,
    string? Cwd)
{
    // Tunables
    // Extensions tried in order when searching PATH on Windows.
    private static readonly string[] WindowsExeExtensions = [".exe", ".cmd", ".bat", ".com"];

    // ─── Public API ───────────────────────────────────────────────────────────

    // Resolves all commands in a potentially chained shell command line.
    // Returns empty when the command cannot be safely parsed (fail-closed).
    internal static IReadOnlyList<ExecCommandResolution> ResolveForAllowlist(
        IReadOnlyList<string> command,
        string? rawCommand,
        string? cwd,
        IReadOnlyDictionary<string, string>? env)
    {
        var shell = ExecShellWrapperParser.Extract(command, rawCommand);
        if (shell.IsWrapper)
        {
            // Fail closed: if we cannot parse the shell payload, treat as allowlist miss.
            if (shell.Command is null) return [];
            var segments = SplitShellCommandChain(shell.Command);
            if (segments is null) return [];

            var resolutions = new List<ExecCommandResolution>(segments.Count);
            foreach (var segment in segments)
            {
                var token = ParseFirstToken(segment);
                if (token is null) return [];
                var res = ResolveExecutable(token, cwd, env);
                if (res is null) return [];
                resolutions.Add(res);
            }
            return resolutions;
        }

        var single = Resolve(command, rawCommand, cwd, env);
        return single is null ? [] : [single];
    }

    internal static ExecCommandResolution? Resolve(
        IReadOnlyList<string> command,
        string? rawCommand,
        string? cwd,
        IReadOnlyDictionary<string, string>? env)
    {
        var trimmedRaw = rawCommand?.Trim() ?? string.Empty;
        if (trimmedRaw.Length > 0)
        {
            var token = ParseFirstToken(trimmedRaw);
            if (token is not null)
                return ResolveExecutable(token, cwd, env);
        }
        return ResolveFromArgv(command, cwd, env);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    // Strips env wrappers and resolves the first real token.
    private static ExecCommandResolution? ResolveFromArgv(
        IReadOnlyList<string> command, string? cwd, IReadOnlyDictionary<string, string>? env)
    {
        var effective = ExecEnvInvocationUnwrapper.UnwrapDispatchWrappersForResolution(command);
        if (effective.Count == 0) return null;
        var raw = effective[0].Trim();
        return raw.Length == 0 ? null : ResolveExecutable(raw, cwd, env);
    }

    private static ExecCommandResolution? ResolveExecutable(
        string rawExecutable, string? cwd, IReadOnlyDictionary<string, string>? env)
    {
        var expanded = ExpandTilde(rawExecutable);
        var hasPathSep = expanded.Contains('/') || expanded.Contains('\\');

        string? resolvedPath;
        if (hasPathSep)
        {
            if (Path.IsPathRooted(expanded))
            {
                resolvedPath = expanded;
            }
            else
            {
                var base_ = cwd?.Trim();
                var root = string.IsNullOrEmpty(base_) ? Directory.GetCurrentDirectory() : base_;
                resolvedPath = Path.GetFullPath(Path.Combine(root, expanded));
            }
        }
        else
        {
            var searchPaths = GetSearchPaths(env);
            resolvedPath = FindExecutable(expanded, searchPaths);
        }

        var name = resolvedPath is not null
            ? Path.GetFileName(resolvedPath)
            : expanded;

        return new ExecCommandResolution(expanded, resolvedPath, name, cwd);
    }

    // Extracts the first shell-tokenized word from a command string.
    // Handles simple quoting ('"' and "'") but not full shell parsing.
    private static string? ParseFirstToken(string command)
    {
        var trimmed = command.Trim();
        if (trimmed.Length == 0) return null;

        var first = trimmed[0];
        if (first == '"' || first == '\'')
        {
            var rest = trimmed.AsSpan(1);
            var end = rest.IndexOf(first);
            return end >= 0 ? rest[..end].ToString() : rest.ToString();
        }

        var space = trimmed.AsSpan().IndexOfAny(' ', '\t');
        return space >= 0 ? trimmed[..space] : trimmed;
    }

    // ─── Shell command chain splitting ────────────────────────────────────────

    // Splits a shell command string on ;, &&, ||, |, &, \n.
    // Returns null (fail-closed) on command/process substitution: $(...), `...`, <(...), >(...).
    private static IReadOnlyList<string>? SplitShellCommandChain(string command)
    {
        var trimmed = command.Trim();
        if (trimmed.Length == 0) return null;

        var segments = new List<string>();
        var current = new System.Text.StringBuilder();
        bool inSingle = false, inDouble = false, escaped = false;
        var chars = trimmed.ToCharArray();

        bool appendCurrent()
        {
            var seg = current.ToString().Trim();
            if (seg.Length == 0) return false;
            segments.Add(seg);
            current.Clear();
            return true;
        }

        for (int i = 0; i < chars.Length; i++)
        {
            char ch = chars[i];
            char? next = i + 1 < chars.Length ? chars[i + 1] : null;

            if (escaped) { current.Append(ch); escaped = false; continue; }

            if (ch == '\\' && !inSingle) { current.Append(ch); escaped = true; continue; }

            if (ch == '\'' && !inDouble) { inSingle = !inSingle; current.Append(ch); continue; }

            if (ch == '"' && !inSingle) { inDouble = !inDouble; current.Append(ch); continue; }

            // Fail-closed on command/process substitution.
            if (!inSingle && ShouldFailClosed(ch, next, inDouble))
                return null;

            if (!inSingle && !inDouble)
            {
                char? prev = i > 0 ? chars[i - 1] : null;
                var step = ChainDelimiterStep(ch, prev, next);
                if (step.HasValue)
                {
                    if (!appendCurrent()) return null;
                    i += step.Value - 1; // -1 because the loop also increments i
                    continue;
                }
            }

            current.Append(ch);
        }

        if (escaped || inSingle || inDouble) return null;
        if (!appendCurrent()) return null;
        return segments;
    }

    private static bool ShouldFailClosed(char ch, char? next, bool inDouble)
    {
        // In double-quoted context, only backtick and $( are fail-closed.
        if (inDouble) return (ch == '`') || (ch == '$' && next == '(');

        // Unquoted: backtick, $(, <(, >(
        return (ch == '`') ||
               (ch == '$' && next == '(') ||
               (ch == '<' && next == '(') ||
               (ch == '>' && next == '(');
    }

    // Returns how many characters to skip (1 or 2) when a chain delimiter is found, or null.
    private static int? ChainDelimiterStep(char ch, char? prev, char? next)
    {
        if (ch == ';' || ch == '\n') return 1;

        if (ch == '&')
        {
            if (next == '&') return 2;
            // Keep fd redirections like 2>&1 or &>file intact.
            return (prev == '>' || next == '>') ? null : (int?)1;
        }

        if (ch == '|')
        {
            if (next == '|' || next == '&') return 2;
            return 1;
        }

        return null;
    }

    // ─── PATH search ──────────────────────────────────────────────────────────

    private static string? FindExecutable(string name, IReadOnlyList<string> searchPaths)
    {
        foreach (var dir in searchPaths)
        {
            if (string.IsNullOrEmpty(dir)) continue;
            var candidate = Path.Combine(dir, name);

            // Try exact name first (in case the caller already included the extension).
            if (File.Exists(candidate)) return candidate;

            // Try Windows executable extensions.
            foreach (var ext in WindowsExeExtensions)
            {
                var withExt = candidate + ext;
                if (File.Exists(withExt)) return withExt;
            }
        }
        return null;
    }

    private static IReadOnlyList<string> GetSearchPaths(IReadOnlyDictionary<string, string>? env)
    {
        // The Swift counterpart reads env["PATH"] with ':' separator (POSIX).
        // On Windows the separator is ';', but agents may send POSIX-style paths.
        var raw = env?.GetValueOrDefault("PATH") ?? string.Empty;
        if (!string.IsNullOrEmpty(raw))
        {
            // Accept both separators.
            var parts = raw.Split([';', ':'], StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length > 0) return parts;
        }
        return PreferredPaths();
    }

    // returns well-known Windows system dirs.
    private static IReadOnlyList<string> PreferredPaths()
    {
        var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var system32 = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32");

        return [system32, system,
                Path.Combine(system32, "OpenSSH"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Git", "usr", "bin"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Git", "bin")];
    }

    // Expands a leading '~' to the current user's home directory.
    private static string ExpandTilde(string path)
    {
        if (!path.StartsWith('~')) return path;
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return path.Length == 1 ? home : home + path[1..];
    }
}

// Formats a command array for display in approval prompts.
internal static class ExecCommandFormatter
{
    internal static string DisplayString(IReadOnlyList<string> argv)
    {
        return string.Join(" ", argv.Select(arg =>
        {
            var trimmed = arg.Trim();
            if (trimmed.Length == 0) return "\"\"";
            bool needsQuotes = trimmed.Any(c => char.IsWhiteSpace(c) || c == '"');
            if (!needsQuotes) return trimmed;
            return "\"" + trimmed.Replace("\"", "\\\"") + "\"";
        }));
    }

    internal static string DisplayString(IReadOnlyList<string> argv, string? rawCommand)
    {
        var trimmed = rawCommand?.Trim() ?? string.Empty;
        return trimmed.Length > 0 ? trimmed : DisplayString(argv);
    }
}
