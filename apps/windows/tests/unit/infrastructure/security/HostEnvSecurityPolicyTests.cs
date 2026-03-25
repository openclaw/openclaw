using OpenClawWindows.Infrastructure.Security;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Security;

public sealed class HostEnvSecurityPolicyTests
{
    // --- BlockedKeys parity with host-env-security-policy.json ---

    [Theory]
    [InlineData("NODE_OPTIONS")]
    [InlineData("NODE_PATH")]
    [InlineData("PYTHONHOME")]
    [InlineData("PYTHONPATH")]
    [InlineData("PERL5LIB")]
    [InlineData("PERL5OPT")]
    [InlineData("RUBYLIB")]
    [InlineData("RUBYOPT")]
    [InlineData("BASH_ENV")]
    [InlineData("ENV")]
    [InlineData("GIT_EXTERNAL_DIFF")]
    [InlineData("SHELL")]
    [InlineData("SHELLOPTS")]
    [InlineData("PS4")]
    [InlineData("GCONV_PATH")]
    [InlineData("IFS")]
    [InlineData("SSLKEYLOGFILE")]
    public void BlockedKeys_ContainsExpectedKey(string key)
    {
        HostEnvSecurityPolicy.BlockedKeys.Should().Contain(key);
    }

    [Fact]
    public void BlockedKeys_HasExactCount()
    {
        HostEnvSecurityPolicy.BlockedKeys.Should().HaveCount(17);
    }

    // --- BlockedOverrideKeys parity ---

    [Theory]
    [InlineData("HOME")]
    [InlineData("ZDOTDIR")]
    [InlineData("GIT_SSH_COMMAND")]
    [InlineData("GIT_SSH")]
    [InlineData("GIT_PROXY_COMMAND")]
    [InlineData("GIT_ASKPASS")]
    [InlineData("SSH_ASKPASS")]
    [InlineData("LESSOPEN")]
    [InlineData("LESSCLOSE")]
    [InlineData("PAGER")]
    [InlineData("MANPAGER")]
    [InlineData("GIT_PAGER")]
    [InlineData("EDITOR")]
    [InlineData("VISUAL")]
    [InlineData("FCEDIT")]
    [InlineData("SUDO_EDITOR")]
    [InlineData("PROMPT_COMMAND")]
    [InlineData("HISTFILE")]
    [InlineData("PERL5DB")]
    [InlineData("PERL5DBCMD")]
    [InlineData("OPENSSL_CONF")]
    [InlineData("OPENSSL_ENGINES")]
    [InlineData("PYTHONSTARTUP")]
    [InlineData("WGETRC")]
    [InlineData("CURL_HOME")]
    public void BlockedOverrideKeys_ContainsExpectedKey(string key)
    {
        HostEnvSecurityPolicy.BlockedOverrideKeys.Should().Contain(key);
    }

    [Fact]
    public void BlockedOverrideKeys_HasExactCount()
    {
        HostEnvSecurityPolicy.BlockedOverrideKeys.Should().HaveCount(25);
    }

    // --- BlockedOverridePrefixes parity ---

    [Fact]
    public void BlockedOverridePrefixes_ContainsGitConfigPrefix()
    {
        HostEnvSecurityPolicy.BlockedOverridePrefixes.Should().Contain("GIT_CONFIG_");
    }

    [Fact]
    public void BlockedOverridePrefixes_ContainsNpmConfigPrefix()
    {
        HostEnvSecurityPolicy.BlockedOverridePrefixes.Should().Contain("NPM_CONFIG_");
    }

    [Fact]
    public void BlockedOverridePrefixes_HasExactCount()
    {
        HostEnvSecurityPolicy.BlockedOverridePrefixes.Should().HaveCount(2);
    }

    // --- BlockedPrefixes parity ---

    [Fact]
    public void BlockedPrefixes_ContainsDyldPrefix()
    {
        HostEnvSecurityPolicy.BlockedPrefixes.Should().Contain("DYLD_");
    }

    [Fact]
    public void BlockedPrefixes_ContainsLdPrefix()
    {
        HostEnvSecurityPolicy.BlockedPrefixes.Should().Contain("LD_");
    }

    [Fact]
    public void BlockedPrefixes_ContainsBashFuncPrefix()
    {
        HostEnvSecurityPolicy.BlockedPrefixes.Should().Contain("BASH_FUNC_");
    }

    [Fact]
    public void BlockedPrefixes_HasExactCount()
    {
        HostEnvSecurityPolicy.BlockedPrefixes.Should().HaveCount(3);
    }

    // --- Case-insensitive lookup (OrdinalIgnoreCase) ---

    [Theory]
    [InlineData("node_options")]
    [InlineData("Node_Options")]
    [InlineData("shell")]
    public void BlockedKeys_IsCaseInsensitive(string key)
    {
        HostEnvSecurityPolicy.BlockedKeys.Should().Contain(key);
    }

    [Theory]
    [InlineData("home")]
    [InlineData("editor")]
    [InlineData("CURL_HOME")]
    public void BlockedOverrideKeys_IsCaseInsensitive(string key)
    {
        HostEnvSecurityPolicy.BlockedOverrideKeys.Should().Contain(key);
    }
}
