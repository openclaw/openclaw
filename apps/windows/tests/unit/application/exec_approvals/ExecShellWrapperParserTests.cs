using OpenClawWindows.Application.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Application.ExecApprovals;

public sealed class ExecShellWrapperParserTests
{
    // ── Non-shell executables ──────────────────────────────────────────────────

    [Theory]
    [InlineData("git")]
    [InlineData("node")]
    [InlineData("python3")]
    [InlineData("dotnet")]
    public void Extract_NonShellExecutable_IsNotWrapper(string exe)
    {
        var result = ExecShellWrapperParser.Extract([exe, "arg"], rawCommand: null);
        result.IsWrapper.Should().BeFalse();
        result.Command.Should().BeNull();
    }

    [Fact]
    public void Extract_EmptyCommand_IsNotWrapper()
    {
        ExecShellWrapperParser.Extract([], rawCommand: null)
            .IsWrapper.Should().BeFalse();
    }

    [Fact]
    public void Extract_WhitespaceOnlyFirstToken_IsNotWrapper()
    {
        ExecShellWrapperParser.Extract(["   "], rawCommand: null)
            .IsWrapper.Should().BeFalse();
    }

    // ── POSIX shells ──────────────────────────────────────────────────────────

    [Theory]
    [InlineData("bash")]
    [InlineData("sh")]
    [InlineData("zsh")]
    [InlineData("dash")]
    [InlineData("ksh")]
    [InlineData("fish")]
    [InlineData("ash")]
    public void Extract_PosixShellWithDashC_IsWrapper(string shell)
    {
        var result = ExecShellWrapperParser.Extract([shell, "-c", "echo hello"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("echo hello");
    }

    [Fact]
    public void Extract_BashWithDashLC_IsWrapper()
    {
        var result = ExecShellWrapperParser.Extract(["bash", "-lc", "echo hello"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("echo hello");
    }

    [Fact]
    public void Extract_BashWithDoubleSlashCommand_IsWrapper()
    {
        var result = ExecShellWrapperParser.Extract(["bash", "--command", "echo hello"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("echo hello");
    }

    [Fact]
    public void Extract_BashWithNoInlineFlag_IsNotWrapper()
    {
        // bash script.sh is not an inline shell wrapper
        var result = ExecShellWrapperParser.Extract(["bash", "script.sh"], rawCommand: null);
        result.IsWrapper.Should().BeFalse();
    }

    [Fact]
    public void Extract_BashAlone_IsNotWrapper()
    {
        var result = ExecShellWrapperParser.Extract(["bash"], rawCommand: null);
        result.IsWrapper.Should().BeFalse();
    }

    [Fact]
    public void Extract_BashDashC_EmptyPayload_IsNotWrapper()
    {
        // bash -c "" has no actual payload — should not be treated as a wrapper.
        var result = ExecShellWrapperParser.Extract(["bash", "-c", "   "], rawCommand: null);
        result.IsWrapper.Should().BeFalse();
    }

    [Fact]
    public void Extract_BashDashC_MissingPayloadToken_IsNotWrapper()
    {
        // bash -c with no third token is malformed.
        var result = ExecShellWrapperParser.Extract(["bash", "-c"], rawCommand: null);
        result.IsWrapper.Should().BeFalse();
    }

    [Fact]
    public void Extract_PosixShell_CaseInsensitiveDetection()
    {
        // Shell names like BASH or Bash must be detected regardless of case.
        var result = ExecShellWrapperParser.Extract(["BASH", "-c", "echo hi"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
    }

    // ── cmd.exe ───────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("cmd")]
    [InlineData("cmd.exe")]
    [InlineData("CMD.EXE")]
    [InlineData("CMD")]
    public void Extract_CmdWithSlashC_IsWrapper(string exe)
    {
        var result = ExecShellWrapperParser.Extract([exe, "/c", "dir"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("dir");
    }

    [Fact]
    public void Extract_CmdWithMultipleArgsAfterSlashC_PayloadIsJoined()
    {
        var result = ExecShellWrapperParser.Extract(["cmd", "/c", "echo", "hello", "world"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("echo hello world");
    }

    [Fact]
    public void Extract_CmdWithoutSlashC_IsNotWrapper()
    {
        var result = ExecShellWrapperParser.Extract(["cmd", "script.bat"], rawCommand: null);
        result.IsWrapper.Should().BeFalse();
    }

    [Fact]
    public void Extract_CmdSlashCNotFirstFlag_StillDetected()
    {
        // cmd /q /c "dir" — /c can appear after other flags.
        var result = ExecShellWrapperParser.Extract(["cmd", "/q", "/c", "dir"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("dir");
    }

    // ── PowerShell / pwsh ──────────────────────────────────────────────────────

    [Theory]
    [InlineData("powershell")]
    [InlineData("powershell.exe")]
    [InlineData("pwsh")]
    [InlineData("pwsh.exe")]
    public void Extract_PowerShellWithDashC_IsWrapper(string exe)
    {
        var result = ExecShellWrapperParser.Extract([exe, "-c", "Get-Process"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("Get-Process");
    }

    [Fact]
    public void Extract_PowerShellWithDashCommand_IsWrapper()
    {
        var result = ExecShellWrapperParser.Extract(["powershell", "-Command", "Get-Process"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("Get-Process");
    }

    [Fact]
    public void Extract_PowerShellWithDoubleSlashCommand_IsWrapper()
    {
        var result = ExecShellWrapperParser.Extract(["pwsh", "--command", "Get-Process"], rawCommand: null);
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("Get-Process");
    }

    [Fact]
    public void Extract_PowerShellDashDashSeparator_StopsOptionParsing()
    {
        // "--" ends option parsing; a "-c" after it is not the command flag.
        // An attacker cannot use "pwsh -- -c evil" to inject a shell wrapper.
        var result = ExecShellWrapperParser.Extract(["powershell", "--", "-c", "evil"], rawCommand: null);
        result.IsWrapper.Should().BeFalse(
            because: "-- terminates option parsing, so -c after -- is not a wrapper flag");
    }

    // ── Raw command takes precedence over parsed payload ───────────────────────

    [Fact]
    public void Extract_RawCommandTakesPrecedenceOverExtractedPayload()
    {
        // When rawCommand is provided it is used as the command string instead of the
        // argv-parsed payload — this is the authoritative display/match string.
        var result = ExecShellWrapperParser.Extract(
            ["bash", "-c", "echo from argv"],
            rawCommand: "echo from rawCommand");
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("echo from rawCommand");
    }

    [Fact]
    public void Extract_EmptyRawCommand_FallsBackToArgvPayload()
    {
        var result = ExecShellWrapperParser.Extract(
            ["bash", "-c", "echo from argv"],
            rawCommand: "   ");
        result.IsWrapper.Should().BeTrue();
        result.Command.Should().Be("echo from argv");
    }

    // ── env-wrapped shell detection (recursive unwrapping) ────────────────────

    [Fact]
    public void Extract_EnvWrappedBash_RecursivelyDetectsShellWrapper()
    {
        // `env LANG=C bash -c "echo hi"` — env is unwrapped and bash is then detected.
        var result = ExecShellWrapperParser.Extract(
            ["env", "LANG=C", "bash", "-c", "echo hi"],
            rawCommand: null);
        result.IsWrapper.Should().BeTrue(
            because: "the env wrapper must be stripped to reveal the underlying bash shell");
    }

    [Fact]
    public void Extract_EnvWithDashUOption_UnwrapsCorrectly()
    {
        // env -u VAR bash -c "cmd" — the -u flag with its value must be consumed.
        var result = ExecShellWrapperParser.Extract(
            ["env", "-u", "SOME_VAR", "bash", "-c", "cmd"],
            rawCommand: null);
        result.IsWrapper.Should().BeTrue();
    }

    [Fact]
    public void Extract_EnvWithUnknownFlag_IsNotWrapper()
    {
        // An unknown env flag causes fail-safe: unwrap is aborted → not a wrapper.
        var result = ExecShellWrapperParser.Extract(
            ["env", "--unknown-flag", "bash", "-c", "evil"],
            rawCommand: null);
        result.IsWrapper.Should().BeFalse(
            because: "unknown env flags cause a fail-safe abort of the unwrap chain");
    }

    [Fact]
    public void Extract_MaxWrapperDepthExceeded_IsNotWrapper()
    {
        // Deeply nested env chains are not unwrapped beyond MaxWrapperDepth —
        // prevents unbounded recursion and pathological inputs.
        var command = new List<string>
        {
            "env", "A=1",
            "env", "B=2",
            "env", "C=3",
            "env", "D=4",
            "env", "E=5",   // 5th level exceeds MaxWrapperDepth (4)
            "bash", "-c", "evil",
        };
        var result = ExecShellWrapperParser.Extract(command, rawCommand: null);
        result.IsWrapper.Should().BeFalse(
            because: "recursion depth is bounded by MaxWrapperDepth to prevent abuse");
    }
}
