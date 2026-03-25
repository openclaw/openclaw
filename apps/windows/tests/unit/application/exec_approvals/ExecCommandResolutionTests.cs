using OpenClawWindows.Application.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Application.ExecApprovals;

// Tests for ExecCommandResolution focusing on the security-critical behaviours:
// fail-closed on command/process substitution, correct chain splitting, and tilde expansion.
public sealed class ExecCommandResolutionTests
{
    // ── Command substitution — must fail closed ────────────────────────────────

    [Fact]
    public void ResolveForAllowlist_DollarParenSubstitution_FailsClosed()
    {
        // $(...) allows arbitrary code execution inside the shell command.
        // The resolver must produce an empty result (fail-closed) so that an agent
        // cannot inject executables through subshell expansion.
        var result = Resolve(["bash", "-c", "$(evil)"], rawCommand: null);
        result.Should().BeEmpty(
            because: "$(...) command substitution must be rejected to prevent shell injection");
    }

    [Fact]
    public void ResolveForAllowlist_BacktickSubstitution_FailsClosed()
    {
        // Backtick substitution is the older form of $(...).
        var result = Resolve(["bash", "-c", "`evil`"], rawCommand: null);
        result.Should().BeEmpty(
            because: "backtick substitution must be rejected to prevent shell injection");
    }

    [Fact]
    public void ResolveForAllowlist_ProcessSubstitutionIn_FailsClosed()
    {
        // <(...) spawns a subshell and connects its output as a file descriptor.
        var result = Resolve(["bash", "-c", "diff <(cmd1) <(cmd2)"], rawCommand: null);
        result.Should().BeEmpty(
            because: "<(...) process substitution must be rejected");
    }

    [Fact]
    public void ResolveForAllowlist_ProcessSubstitutionOut_FailsClosed()
    {
        var result = Resolve(["bash", "-c", "tee >(cmd)"], rawCommand: null);
        result.Should().BeEmpty(
            because: ">(...) process substitution must be rejected");
    }

    [Fact]
    public void ResolveForAllowlist_SubstitutionInDoubleQuotes_FailsClosed()
    {
        // $() inside double quotes still executes — must still be rejected.
        var result = Resolve(["bash", "-c", "echo \"$(evil)\""], rawCommand: null);
        result.Should().BeEmpty(
            because: "$(...) inside double quotes still performs substitution");
    }

    [Fact]
    public void ResolveForAllowlist_BacktickInDoubleQuotes_FailsClosed()
    {
        var result = Resolve(["bash", "-c", "echo \"`evil`\""], rawCommand: null);
        result.Should().BeEmpty();
    }

    // ── Command substitution inside single quotes is safe ─────────────────────

    [Fact]
    public void ResolveForAllowlist_SubstitutionInsideSingleQuotes_IsNotFailClosed()
    {
        // Inside single quotes, $() and backticks are literal characters —
        // no substitution occurs, so this must NOT be rejected.
        var result = Resolve(["bash", "-c", "echo '$(literal)'"], rawCommand: null);
        result.Should().NotBeEmpty(
            because: "dollar-sign inside single quotes is a literal string, not substitution");
    }

    // ── Unclosed quotes — fail closed ─────────────────────────────────────────

    [Fact]
    public void ResolveForAllowlist_UnclosedDoubleQuote_FailsClosed()
    {
        // An unclosed quote means the command is indeterminate — reject for safety.
        var result = Resolve(["bash", "-c", "\"unclosed"], rawCommand: null);
        result.Should().BeEmpty(
            because: "an unclosed double-quote produces an ambiguous command boundary");
    }

    [Fact]
    public void ResolveForAllowlist_UnclosedSingleQuote_FailsClosed()
    {
        var result = Resolve(["bash", "-c", "'unclosed"], rawCommand: null);
        result.Should().BeEmpty(
            because: "an unclosed single-quote produces an ambiguous command boundary");
    }

    // ── Chain splitting — correct segmentation ─────────────────────────────────

    [Fact]
    public void ResolveForAllowlist_NonShellCommand_ReturnsSingleResolution()
    {
        // A non-shell-wrapper command is always a single resolution.
        var sys = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var cmd = Path.Combine(sys, "cmd.exe");

        var result = Resolve([cmd, "/help"], rawCommand: null);

        result.Should().HaveCount(1);
        result[0].RawExecutable.Should().Be(cmd);
    }

    [Fact]
    public void ResolveForAllowlist_SemicolonChain_ProducesTwoResolutions()
    {
        // `cmd /c "echo a; echo b"` → two segments → two resolutions.
        // An allowlist that only contains echo must reject rm even if rm appears
        // later in the chain — MatchAll all-or-nothing semantics enforce this.
        var result = Resolve(["cmd", "/c", "echo a; echo b"], rawCommand: null);
        result.Should().HaveCount(2,
            because: "semicolons are chain delimiters that produce separate command segments");
    }

    [Fact]
    public void ResolveForAllowlist_DoubleAmpersandChain_ProducesTwoResolutions()
    {
        var result = Resolve(["cmd", "/c", "echo a && echo b"], rawCommand: null);
        result.Should().HaveCount(2);
    }

    [Fact]
    public void ResolveForAllowlist_PipeChain_ProducesTwoResolutions()
    {
        var result = Resolve(["bash", "-c", "echo a | cat"], rawCommand: null);
        result.Should().HaveCount(2);
    }

    [Fact]
    public void ResolveForAllowlist_NewlineChain_ProducesTwoResolutions()
    {
        var result = Resolve(["bash", "-c", "echo a\necho b"], rawCommand: null);
        result.Should().HaveCount(2);
    }

    [Fact]
    public void ResolveForAllowlist_EmptySegmentInChain_FailsClosed()
    {
        // A chain delimiter that produces an empty segment (e.g. leading semicolon)
        // is rejected so the resolver cannot be tricked into ignoring a segment.
        var result = Resolve(["bash", "-c", "; echo evil"], rawCommand: null);
        result.Should().BeEmpty(
            because: "an empty command segment from a leading delimiter is ambiguous and rejected");
    }

    // ── Tilde expansion ───────────────────────────────────────────────────────

    [Fact]
    public void Resolve_TildePrefix_ExpandsToUserHomeDirectory()
    {
        // ~/tools/myscript must expand to the user's home directory.
        // This is needed so allowlist patterns like ~/scripts/* work correctly.
        var result = ExecCommandResolution.Resolve(
            command: ["~/tools/myscript"],
            rawCommand: null,
            cwd: null,
            env: null);

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        result.Should().NotBeNull();
        result!.ResolvedPath.Should().StartWith(home,
            because: "~ must expand to the current user's home directory");
    }

    [Fact]
    public void Resolve_TildeAlone_ExpandsToHomeDirectoryItself()
    {
        var result = ExecCommandResolution.Resolve(
            command: ["~"],
            rawCommand: null,
            cwd: null,
            env: null);

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        result.Should().NotBeNull();
        result!.ResolvedPath.Should().Be(home);
    }

    // ── Relative path resolution via cwd ─────────────────────────────────────

    [Fact]
    public void Resolve_RelativePath_ResolvedAgainstCwd()
    {
        // A relative path like ./scripts/run.sh is resolved relative to cwd,
        // not the process working directory — this is security-relevant because
        // cwd comes from the agent request and should be contained.
        var cwd = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var result = ExecCommandResolution.Resolve(
            command: ["./subdir/tool"],
            rawCommand: null,
            cwd: cwd,
            env: null);

        result.Should().NotBeNull();
        result!.ResolvedPath.Should().StartWith(cwd,
            because: "relative paths must be anchored to the request cwd, not the process cwd");
    }

    // ── env wrapper stripped for resolution ───────────────────────────────────

    [Fact]
    public void ResolveForAllowlist_EnvWrappedCommand_ResolvesInnerExecutable()
    {
        // `env VAR=value git commit` — env is stripped and git is the resolved executable.
        var result = Resolve(["env", "SOME_VAR=value", "/usr/bin/git", "commit"], rawCommand: null);

        result.Should().HaveCount(1);
        result[0].RawExecutable.Should().Be("/usr/bin/git");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static IReadOnlyList<ExecCommandResolution> Resolve(
        IReadOnlyList<string> command,
        string? rawCommand,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? env = null) =>
        ExecCommandResolution.ResolveForAllowlist(command, rawCommand, cwd, env);
}
