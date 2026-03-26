// Generated file. Do not edit directly.
// Source: src/infra/host-env-security-policy.json
// Regenerate: node scripts/generate-host-env-security-policy-swift.mjs --write

import Foundation

enum HostEnvSecurityPolicy {
    static let blockedKeys: Set<String> = [
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "PYTHONWARNINGS",
        "PYTHONBREAKPOINT",
        "PERL5LIB",
        "PERL5OPT",
        "PERL_MB_OPT",
        "RUBYLIB",
        "RUBYOPT",
        "BASH_ENV",
        "ENV",
        "GIT_EXTERNAL_DIFF",
        "GIT_EXEC_PATH",
        "SHELL",
        "SHELLOPTS",
        "PS4",
        "GCONV_PATH",
        "IFS",
        "SSLKEYLOGFILE",
        "GLIBC_TUNABLES",
        "JAVA_TOOL_OPTIONS",
        "JAVA_OPTIONS",
        "_JAVA_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "DOTNET_STARTUP_HOOKS",
        "DOTNET_ADDITIONAL_DEPS",
        "MAVEN_OPTS",
        "SBT_OPTS",
        "GRADLE_OPTS",
        "ANT_OPTS",
        "LD_AUDIT",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "PROMPT_COMMAND",
        "GOPATH",
        "CARGO_HOME"
    ]

    static let blockedOverrideKeys: Set<String> = [
        "HOME",
        "GRADLE_USER_HOME",
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
        "HISTFILE",
        "PERL5DB",
        "PERL5DBCMD",
        "OPENSSL_CONF",
        "OPENSSL_ENGINES",
        "PYTHONSTARTUP",
        "WGETRC",
        "CURL_HOME",
        "BROWSER",
        "SDKMAN_DIR",
        "NVM_DIR"
    ]

    static let blockedOverridePrefixes: [String] = [
        "GIT_CONFIG_",
        "NPM_CONFIG_",
        "OPENCLAW_"
    ]

    static let blockedOverridePrefixes: [String] = [

    ]

    static let blockedPrefixes: [String] = [
        "DYLD_",
        "LD_",
        "BASH_FUNC_"
    ]
}
