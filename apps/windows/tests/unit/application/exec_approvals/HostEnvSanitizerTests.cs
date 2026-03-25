using OpenClawWindows.Application.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Application.ExecApprovals;

public sealed class HostEnvSanitizerTests
{
    // ── PATH override is always rejected ──────────────────────────────────────

    [Fact]
    public void Sanitize_PathOverride_IsRejected()
    {
        // An agent cannot hijack PATH to redirect which binary gets executed.
        var result = Sanitize(new() { ["PATH"] = "/evil/bin" });
        if (result.TryGetValue("PATH", out var path))
            path.Should().NotBe("/evil/bin",
                because: "PATH is a security boundary that can never be overridden by a request");
    }

    [Fact]
    public void Sanitize_PathOverride_CaseInsensitive_IsRejected()
    {
        var result = Sanitize(new() { ["path"] = "/evil/bin" });
        if (result.TryGetValue("path", out var path))
            path.Should().NotBe("/evil/bin");
    }

    // ── Blocked override keys ─────────────────────────────────────────────────

    [Theory]
    [InlineData("HOME")]          // redirect home → hijack all config files
    [InlineData("ZDOTDIR")]       // zsh startup file injection
    [InlineData("GIT_SSH_COMMAND")]  // git credential / proxy hijack
    [InlineData("GIT_SSH")]
    [InlineData("GIT_PROXY_COMMAND")]
    [InlineData("GIT_ASKPASS")]   // credential prompt hijack
    [InlineData("SSH_ASKPASS")]
    [InlineData("PAGER")]         // pager injection (less with LESS env)
    [InlineData("MANPAGER")]
    [InlineData("GIT_PAGER")]
    [InlineData("EDITOR")]        // editor injection
    [InlineData("VISUAL")]
    [InlineData("SUDO_EDITOR")]
    [InlineData("FCEDIT")]
    [InlineData("PROMPT_COMMAND")]  // bash pre-prompt execution
    [InlineData("HISTFILE")]        // exfiltrate command history
    [InlineData("PERL5DB")]         // Perl debugger injection
    [InlineData("PERL5DBCMD")]
    [InlineData("OPENSSL_CONF")]    // OpenSSL config hijack
    [InlineData("OPENSSL_ENGINES")]
    [InlineData("PYTHONSTARTUP")]   // Python startup script injection
    [InlineData("WGETRC")]          // wget config redirect
    [InlineData("CURL_HOME")]       // curl config redirect
    [InlineData("LESSOPEN")]        // less input preprocessor injection
    [InlineData("LESSCLOSE")]
    public void Sanitize_BlockedOverrideKey_CannotBeSetByAgent(string key)
    {
        var result = Sanitize(new() { [key] = "evil-injected-value" });
        if (result.TryGetValue(key, out var val))
            val.Should().NotBe("evil-injected-value",
                because: $"{key} is a blocked override key that could enable privilege escalation");
    }

    // ── Blocked override prefixes ─────────────────────────────────────────────

    [Theory]
    [InlineData("GIT_CONFIG_GLOBAL")]    // redirect global git config
    [InlineData("GIT_CONFIG_NOSYSTEM")]  // suppress system-level git security
    [InlineData("GIT_CONFIG_COUNT")]
    [InlineData("NPM_CONFIG_REGISTRY")]  // redirect npm registry to attacker server
    [InlineData("NPM_CONFIG_PREFIX")]    // redirect where npm installs binaries
    [InlineData("NPM_CONFIG_CACHE")]
    public void Sanitize_BlockedOverridePrefix_CannotBeSetByAgent(string key)
    {
        var result = Sanitize(new() { [key] = "evil-injected-value" });
        if (result.TryGetValue(key, out var val))
            val.Should().NotBe("evil-injected-value",
                because: $"{key} matches a blocked override prefix");
    }

    // ── Blocked host-environment keys (removed even when already in host env) ─

    [Theory]
    [InlineData("NODE_OPTIONS")]     // node CLI flag injection (e.g. --require evil.js)
    [InlineData("NODE_PATH")]        // module resolution hijack
    [InlineData("PYTHONHOME")]       // Python interpreter redirect
    [InlineData("PYTHONPATH")]       // Python module injection
    [InlineData("BASH_ENV")]         // bash sources this file on non-interactive start
    [InlineData("ENV")]              // sh/dash sources this on non-interactive start
    [InlineData("GIT_EXTERNAL_DIFF")]// arbitrary binary executed by git
    [InlineData("SHELL")]            // controls which shell subprocesses use
    [InlineData("SHELLOPTS")]        // injects bash shell options (e.g. xtrace)
    [InlineData("PS4")]              // xtrace prefix — code execution via expansion
    [InlineData("SSLKEYLOGFILE")]    // silently exfiltrates TLS session keys
    [InlineData("IFS")]              // word splitting injection
    [InlineData("GCONV_PATH")]       // glibc character set library injection
    public void Sanitize_BlockedHostKey_IsStrippedEvenIfPresentInHostEnvironment(string key)
    {
        var original = Environment.GetEnvironmentVariable(key);
        try
        {
            Environment.SetEnvironmentVariable(key, "dangerous-host-value");
            var result = Sanitize(overrides: null);
            result.Should().NotContainKey(key,
                because: $"{key} is security-blocked and must not be passed to child processes");
        }
        finally
        {
            Environment.SetEnvironmentVariable(key, original);
        }
    }

    // ── Blocked prefix keys from host environment ──────────────────────────────

    [Theory]
    [InlineData("DYLD_LIBRARY_PATH")]       // macOS dynamic linker injection
    [InlineData("DYLD_INSERT_LIBRARIES")]   // macOS equivalent of LD_PRELOAD
    [InlineData("DYLD_FALLBACK_LIBRARY_PATH")]
    [InlineData("LD_PRELOAD")]              // Linux shared library injection
    [InlineData("LD_LIBRARY_PATH")]
    [InlineData("LD_AUDIT")]               // Linux runtime auditing injection
    [InlineData("BASH_FUNC_evil__")]       // bash function export via env
    public void Sanitize_BlockedPrefixKey_IsStrippedEvenIfPresentInHostEnvironment(string key)
    {
        var original = Environment.GetEnvironmentVariable(key);
        try
        {
            Environment.SetEnvironmentVariable(key, "dangerous-host-value");
            var result = Sanitize(overrides: null);
            result.Should().NotContainKey(key,
                because: $"{key} matches a blocked environment variable prefix");
        }
        finally
        {
            Environment.SetEnvironmentVariable(key, original);
        }
    }

    // ── Safe keys pass through ────────────────────────────────────────────────

    [Fact]
    public void Sanitize_ArbitraryUserKey_PassesThrough()
    {
        var result = Sanitize(new() { ["MY_APP_TOKEN"] = "safe-value" });
        result.Should().ContainKey("MY_APP_TOKEN")
            .WhoseValue.Should().Be("safe-value");
    }

    [Fact]
    public void Sanitize_NullOverrides_DoesNotThrow()
    {
        var act = () => Sanitize(overrides: null);
        act.Should().NotThrow();
    }

    // ── Shell wrapper mode — extra override restriction ────────────────────────

    [Theory]
    [InlineData("TERM")]
    [InlineData("LANG")]
    [InlineData("LC_ALL")]
    [InlineData("LC_CTYPE")]
    [InlineData("LC_MESSAGES")]
    [InlineData("COLORTERM")]
    [InlineData("NO_COLOR")]
    [InlineData("FORCE_COLOR")]
    public void Sanitize_ShellWrapperMode_AllowsDisplayAndLocaleKeys(string key)
    {
        // Shell wrapper mode permits only terminal display and locale overrides
        // to prevent environment-based attacks through the shell interpreter.
        var result = Sanitize(new() { [key] = "permitted-value" }, shellWrapper: true);
        result.Should().ContainKey(key)
            .WhoseValue.Should().Be("permitted-value");
    }

    [Fact]
    public void Sanitize_ShellWrapperMode_BlocksArbitraryKey()
    {
        // In shell wrapper mode an agent cannot inject arbitrary env vars.
        var result = Sanitize(new() { ["MY_APP_TOKEN"] = "sneaky-value" }, shellWrapper: true);
        if (result.TryGetValue("MY_APP_TOKEN", out var val))
            val.Should().NotBe("sneaky-value",
                because: "shell wrapper mode only allows display/locale key overrides");
    }

    [Fact]
    public void Sanitize_ShellWrapperMode_StillBlocksPathOverride()
    {
        // PATH is always rejected, even keys that are otherwise allowed in shell wrapper mode.
        var result = Sanitize(new() { ["PATH"] = "/evil/bin" }, shellWrapper: true);
        if (result.TryGetValue("PATH", out var path))
            path.Should().NotBe("/evil/bin");
    }

    // ── Case insensitivity ────────────────────────────────────────────────────

    [Fact]
    public void Sanitize_BlockedOverrideKey_CaseInsensitive()
    {
        // home (lowercase) must be treated as HOME — the check is OrdinalIgnoreCase.
        var result = Sanitize(new() { ["home"] = "evil-home" });
        if (result.TryGetValue("home", out var val))
            val.Should().NotBe("evil-home");
    }

    [Fact]
    public void Sanitize_BlockedOverridePrefix_CaseInsensitive()
    {
        var result = Sanitize(new() { ["git_config_global"] = "evil" });
        if (result.TryGetValue("git_config_global", out var val))
            val.Should().NotBe("evil");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static IReadOnlyDictionary<string, string> Sanitize(
        Dictionary<string, string>? overrides = null,
        bool shellWrapper = false) =>
        HostEnvSanitizer.Sanitize(overrides, shellWrapper);
}
