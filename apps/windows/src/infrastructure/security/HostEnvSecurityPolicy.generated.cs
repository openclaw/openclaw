// Generated file. Do not edit directly.
// Source: src/infra/host-env-security-policy.json
// Regenerate: dotnet run --project apps/windows/tools/HostEnvSecurityPolicyGenerator -- --write

namespace OpenClawWindows.Infrastructure.Security;

internal static class HostEnvSecurityPolicy
{
    internal static readonly HashSet<string> BlockedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERL5LIB",
        "PERL5OPT",
        "RUBYLIB",
        "RUBYOPT",
        "BASH_ENV",
        "ENV",
        "GIT_EXTERNAL_DIFF",
        "SHELL",
        "SHELLOPTS",
        "PS4",
        "GCONV_PATH",
        "IFS",
        "SSLKEYLOGFILE",
    };

    internal static readonly HashSet<string> BlockedOverrideKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "HOME",
        "ZDOTDIR",
        "GIT_SSH_COMMAND",
        "GIT_SSH",
        "GIT_PROXY_COMMAND",
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        "LESSOPEN",
        "LESSCLOSE",
        "PAGER",
        "MANPAGER",
        "GIT_PAGER",
        "EDITOR",
        "VISUAL",
        "FCEDIT",
        "SUDO_EDITOR",
        "PROMPT_COMMAND",
        "HISTFILE",
        "PERL5DB",
        "PERL5DBCMD",
        "OPENSSL_CONF",
        "OPENSSL_ENGINES",
        "PYTHONSTARTUP",
        "WGETRC",
        "CURL_HOME",
    };

    internal static readonly string[] BlockedOverridePrefixes =
    [
        "GIT_CONFIG_",
        "NPM_CONFIG_",
    ];

    internal static readonly string[] BlockedPrefixes =
    [
        "DYLD_",
        "LD_",
        "BASH_FUNC_",
    ];
}
