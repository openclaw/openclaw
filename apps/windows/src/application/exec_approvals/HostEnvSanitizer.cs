namespace OpenClawWindows.Application.ExecApprovals;

// Merges the host process environment with request-scoped overrides while blocking
// security-sensitive variables.
internal static class HostEnvSanitizer
{
    // Blocked keys — sourced from src/infra/host-env-security-policy.json.
    private static readonly HashSet<string> BlockedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "NODE_OPTIONS", "NODE_PATH",
        "PYTHONHOME", "PYTHONPATH",
        "PERL5LIB", "PERL5OPT",
        "RUBYLIB", "RUBYOPT",
        "BASH_ENV", "ENV",
        "GIT_EXTERNAL_DIFF",
        "SHELL", "SHELLOPTS", "PS4",
        "GCONV_PATH", "IFS",
        "SSLKEYLOGFILE",
    };

    // Blocked prefixes — sourced from host-env-security-policy.json.
    private static readonly string[] BlockedPrefixes = ["DYLD_", "LD_", "BASH_FUNC_"];

    // Keys that may never be overridden by request-scoped env (blockedOverrideKeys in policy).
    private static readonly HashSet<string> BlockedOverrideKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "HOME", "ZDOTDIR",
        "GIT_SSH_COMMAND", "GIT_SSH", "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS",
        "LESSOPEN", "LESSCLOSE",
        "PAGER", "MANPAGER", "GIT_PAGER",
        "EDITOR", "VISUAL", "FCEDIT", "SUDO_EDITOR",
        "PROMPT_COMMAND", "HISTFILE",
        "PERL5DB", "PERL5DBCMD",
        "OPENSSL_CONF", "OPENSSL_ENGINES",
        "PYTHONSTARTUP", "WGETRC", "CURL_HOME",
    };

    // Blocked override prefixes — sourced from host-env-security-policy.json.
    private static readonly string[] BlockedOverridePrefixes = ["GIT_CONFIG_", "NPM_CONFIG_"];

    // Shell wrappers only allow safe display/locale overrides.
    private static readonly HashSet<string> ShellWrapperAllowedOverrideKeys =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "TERM", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
            "COLORTERM", "NO_COLOR", "FORCE_COLOR",
        };

    // Builds the sanitized environment dictionary.
    // shellWrapper=true restricts overrides to display/locale keys only.
    internal static IReadOnlyDictionary<string, string> Sanitize(
        IReadOnlyDictionary<string, string>? overrides,
        bool shellWrapper = false)
    {
        var merged = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // Start from the host process environment, removing blocked keys.
        foreach (System.Collections.DictionaryEntry entry in System.Environment.GetEnvironmentVariables())
        {
            var key = (entry.Key as string)?.Trim();
            if (string.IsNullOrEmpty(key)) continue;
            if (IsBlocked(key)) continue;
            merged[key] = (entry.Value as string) ?? string.Empty;
        }

        // Apply request-scoped overrides subject to shell-wrapper and security restrictions.
        var effectiveOverrides = shellWrapper
            ? FilterOverridesForShellWrapper(overrides)
            : overrides;

        if (effectiveOverrides is null) return merged;

        foreach (var kv in effectiveOverrides)
        {
            var key = kv.Key.Trim();
            if (key.Length == 0) continue;
            // PATH is a security boundary — never allow request-scoped PATH overrides.
            if (string.Equals(key, "PATH", StringComparison.OrdinalIgnoreCase)) continue;
            if (IsBlockedOverride(key)) continue;
            if (IsBlocked(key)) continue;
            merged[key] = kv.Value;
        }

        return merged;
    }

    private static bool IsBlocked(string key)
    {
        if (BlockedKeys.Contains(key)) return true;
        return BlockedPrefixes.Any(p => key.StartsWith(p, StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsBlockedOverride(string key)
    {
        if (BlockedOverrideKeys.Contains(key)) return true;
        return BlockedOverridePrefixes.Any(p => key.StartsWith(p, StringComparison.OrdinalIgnoreCase));
    }

    private static IReadOnlyDictionary<string, string>? FilterOverridesForShellWrapper(
        IReadOnlyDictionary<string, string>? overrides)
    {
        if (overrides is null) return null;
        var filtered = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in overrides)
        {
            var key = kv.Key.Trim();
            if (key.Length == 0) continue;
            if (ShellWrapperAllowedOverrideKeys.Contains(key))
                filtered[key] = kv.Value;
        }
        return filtered.Count == 0 ? null : filtered;
    }
}
