using System.Runtime.CompilerServices;
using System.Text;

namespace OpenClawWindows.Domain.Workspace;

/// <summary>
/// Static utilities for agent workspace management.
/// </summary>
public static class AgentWorkspace
{
    public const string AgentsFilename = "AGENTS.md";
    public const string SoulFilename = "SOUL.md";
    public const string IdentityFilename = "IDENTITY.md";
    public const string UserFilename = "USER.md";
    public const string BootstrapFilename = "BOOTSTRAP.md";

    // Tunables
    private const string TemplateDirname = "templates";

    // Captures this source file's path at compile time
    private static readonly string s_thisFilePath = GetThisFilePath();

    private static readonly HashSet<string> s_ignoredEntries = new(StringComparer.OrdinalIgnoreCase)
        { ".DS_Store", ".git", ".gitignore", "desktop.ini", "Thumbs.db" };

    private static readonly HashSet<string> s_templateEntries = new(StringComparer.OrdinalIgnoreCase)
        { AgentsFilename, SoulFilename, IdentityFilename, UserFilename, BootstrapFilename };

    public readonly record struct BootstrapSafety
    {
        public string? UnsafeReason { get; init; }

        public static BootstrapSafety Safe => new() { UnsafeReason = null };
        public static BootstrapSafety Blocked(string reason) => new() { UnsafeReason = reason };
        public bool IsBlocked => UnsafeReason is not null;
    }

    public static string DisplayPath(string path)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.Equals(path, home, StringComparison.OrdinalIgnoreCase)) return "~";
        var prefix = home + Path.DirectorySeparatorChar;
        if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            return "~/" + path[prefix.Length..];
        return path;
    }

    public static string ResolveWorkspacePath(string? userInput)
    {
        var trimmed = userInput?.Trim() ?? string.Empty;
        if (trimmed.Length == 0) return DefaultWorkspacePath();

        // Tilde expansion
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (trimmed == "~") return home;
        if (trimmed.StartsWith("~/", StringComparison.Ordinal))
            return Path.Combine(home, trimmed[2..]);

        // Windows-style env var expansion for %USERPROFILE% etc.
        return Environment.ExpandEnvironmentVariables(trimmed);
    }

    public static string DefaultWorkspacePath()
    {
        // checks OPENCLAW_STATE_DIR env var first
        var stateDir = Environment.GetEnvironmentVariable("OPENCLAW_STATE_DIR");
        if (string.IsNullOrWhiteSpace(stateDir))
            stateDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".openclaw");
        return Path.Combine(stateDir, "workspace");
    }

    public static string AgentsPath(string workspacePath) =>
        Path.Combine(workspacePath, AgentsFilename);

    public static string[] WorkspaceEntries(string workspacePath) =>
        Directory.EnumerateFileSystemEntries(workspacePath)
            .Select(e => Path.GetFileName(e))
            .OfType<string>()
            .Where(n => !s_ignoredEntries.Contains(n))
            .ToArray();

    public static bool IsWorkspaceEmpty(string workspacePath)
    {
        if (!Directory.Exists(workspacePath)) return true;
        try { return WorkspaceEntries(workspacePath).Length == 0; }
        catch { return false; }
    }

    public static bool IsTemplateOnlyWorkspace(string workspacePath)
    {
        try
        {
            var entries = WorkspaceEntries(workspacePath);
            if (entries.Length == 0) return true;
            return Array.TrueForAll(entries, e => s_templateEntries.Contains(e));
        }
        catch { return false; }
    }

    public static BootstrapSafety CheckBootstrapSafety(string workspacePath)
    {
        if (File.Exists(workspacePath))
            return BootstrapSafety.Blocked("Workspace path points to a file.");

        if (!Directory.Exists(workspacePath))
            return BootstrapSafety.Safe;

        // Dir exists — safe if AGENTS.md is already there
        if (File.Exists(AgentsPath(workspacePath))) return BootstrapSafety.Safe;

        try
        {
            var entries = WorkspaceEntries(workspacePath);
            return entries.Length == 0
                ? BootstrapSafety.Safe
                : BootstrapSafety.Blocked("Folder isn't empty. Choose a new folder or add AGENTS.md first.");
        }
        catch
        {
            return BootstrapSafety.Blocked("Couldn't inspect the workspace folder.");
        }
    }

    // Returns the path of the created or existing AGENTS.md.
    public static string Bootstrap(string workspacePath)
    {
        var shouldSeedBootstrap = IsWorkspaceEmpty(workspacePath);
        Directory.CreateDirectory(workspacePath);

        WriteIfAbsent(Path.Combine(workspacePath, AgentsFilename), DefaultTemplate());
        WriteIfAbsent(Path.Combine(workspacePath, SoulFilename), DefaultSoulTemplate());
        WriteIfAbsent(Path.Combine(workspacePath, IdentityFilename), DefaultIdentityTemplate());
        WriteIfAbsent(Path.Combine(workspacePath, UserFilename), DefaultUserTemplate());

        // BOOTSTRAP.md only seeded when the workspace was empty
        if (shouldSeedBootstrap)
            WriteIfAbsent(Path.Combine(workspacePath, BootstrapFilename), DefaultBootstrapTemplate());

        return AgentsPath(workspacePath);
    }

    public static bool NeedsBootstrap(string workspacePath)
    {
        if (!Directory.Exists(workspacePath)) return true;
        if (HasIdentity(workspacePath)) return false;

        var bootstrapPath = Path.Combine(workspacePath, BootstrapFilename);
        if (!File.Exists(bootstrapPath)) return false;

        // BOOTSTRAP.md exists but workspace is still template-only → needs bootstrap
        return IsTemplateOnlyWorkspace(workspacePath);
    }

    public static bool HasIdentity(string workspacePath)
    {
        var identityPath = Path.Combine(workspacePath, IdentityFilename);
        try
        {
            var contents = File.ReadAllText(identityPath, Encoding.UTF8);
            return IdentityLinesHaveValues(contents);
        }
        catch { return false; }
    }

    // ── Templates ─────────────────────────────────────────────────────────────

    public static string DefaultTemplate() =>
        LoadTemplate(AgentsFilename, """
            # AGENTS.md - OpenClaw Workspace

            This folder is the assistant's working directory.

            ## First run (one-time)
            - If BOOTSTRAP.md exists, follow its ritual and delete it once complete.
            - Your agent identity lives in IDENTITY.md.
            - Your profile lives in USER.md.

            ## Backup tip (recommended)
            If you treat this workspace as the agent's "memory", make it a git repo (ideally private) so identity
            and notes are backed up.

            ```bash
            git init
            git add AGENTS.md
            git commit -m "Add agent workspace"
            ```

            ## Safety defaults
            - Don't exfiltrate secrets or private data.
            - Don't run destructive commands unless explicitly asked.
            - Be concise in chat; write longer output to files in this workspace.

            ## Daily memory (recommended)
            - Keep a short daily log at memory/YYYY-MM-DD.md (create memory/ if needed).
            - On session start, read today + yesterday if present.
            - Capture durable facts, preferences, and decisions; avoid secrets.

            ## Customize
            - Add your preferred style, rules, and "memory" here.
            """);

    public static string DefaultSoulTemplate() =>
        LoadTemplate(SoulFilename, """
            # SOUL.md - Persona & Boundaries

            Describe who the assistant is, tone, and boundaries.

            - Keep replies concise and direct.
            - Ask clarifying questions when needed.
            - Never send streaming/partial replies to external messaging surfaces.
            """);

    public static string DefaultIdentityTemplate() =>
        LoadTemplate(IdentityFilename, """
            # IDENTITY.md - Agent Identity

            - Name:
            - Creature:
            - Vibe:
            - Emoji:
            """);

    public static string DefaultUserTemplate() =>
        LoadTemplate(UserFilename, """
            # USER.md - User Profile

            - Name:
            - Preferred address:
            - Pronouns (optional):
            - Timezone (optional):
            - Notes:
            """);

    public static string DefaultBootstrapTemplate() =>
        LoadTemplate(BootstrapFilename, """
            # BOOTSTRAP.md - First Run Ritual (delete after)

            Hello. I was just born.

            ## Your mission
            Start a short, playful conversation and learn:
            - Who am I?
            - What am I?
            - Who are you?
            - How should I call you?

            ## How to ask (cute + helpful)
            Say:
            "Hello! I was just born. Who am I? What am I? Who are you? How should I call you?"

            Then offer suggestions:
            - 3-5 name ideas.
            - 3-5 creature/vibe combos.
            - 5 emoji ideas.

            ## Write these files
            After the user chooses, update:

            1) IDENTITY.md
            - Name
            - Creature
            - Vibe
            - Emoji

            2) USER.md
            - Name
            - Preferred address
            - Pronouns (optional)
            - Timezone (optional)
            - Notes

            3) ~/.openclaw/openclaw.json
            Set identity.name, identity.theme, identity.emoji to match IDENTITY.md.

            ## Cleanup
            Delete BOOTSTRAP.md once this is complete.
            """);

    // ── Internals ─────────────────────────────────────────────────────────────

    private static bool IdentityLinesHaveValues(string content)
    {
        foreach (var line in content.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith('-')) continue;
            var colonIdx = trimmed.IndexOf(':');
            if (colonIdx < 0) continue;
            var value = trimmed[(colonIdx + 1)..].Trim();
            if (value.Length > 0) return true;
        }
        return false;
    }

    private static void WriteIfAbsent(string path, string content)
    {
        if (!File.Exists(path))
            File.WriteAllText(path, content, Encoding.UTF8);
    }

    private static string LoadTemplate(string filename, string fallback)
    {
        foreach (var path in TemplatePaths(filename))
        {
            if (!File.Exists(path)) continue;
            try
            {
                var content = File.ReadAllText(path, Encoding.UTF8);
                var stripped = StripFrontMatter(content);
                if (!string.IsNullOrWhiteSpace(stripped)) return stripped;
            }
            catch { /* ignore read errors, try next candidate */ }
        }
        return fallback;
    }

    private static IEnumerable<string> TemplatePaths(string filename)
    {
        // Dev path — navigate from AgentWorkspace.cs (s_thisFilePath) up 6 levels to openclaw/ root.
        // Windows has one extra directory level (src/) so we traverse 6.
        if (!string.IsNullOrEmpty(s_thisFilePath))
        {
            var path = s_thisFilePath;
            for (var i = 0; i < 6; i++)
                path = Path.GetDirectoryName(path) ?? string.Empty;
            if (!string.IsNullOrEmpty(path))
                yield return Path.Combine(path, "docs", TemplateDirname, filename);
        }

        // Exe-adjacent templates/ directory
        yield return Path.Combine(AppContext.BaseDirectory, TemplateDirname, filename);

        // CWD/docs/templates/
        yield return Path.Combine(Directory.GetCurrentDirectory(), "docs", TemplateDirname, filename);
    }

    // Strips YAML front matter delimited by --- ... --- from template files.
    internal static string StripFrontMatter(string content)
    {
        if (!content.StartsWith("---", StringComparison.Ordinal)) return content;
        var idx = content.IndexOf("\n---", 3, StringComparison.Ordinal);
        if (idx < 0) return content;
        // Skip past the closing "\n---" (4 chars)
        var remainder = content[(idx + 4)..].TrimStart('\r', '\n');
        return remainder + "\n";
    }

    private static string GetThisFilePath([CallerFilePath] string path = "") => path;
}
