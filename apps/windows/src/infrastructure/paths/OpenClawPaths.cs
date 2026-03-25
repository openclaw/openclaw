namespace OpenClawWindows.Infrastructure.Paths;

/// <summary>
/// Reads and normalizes OpenClaw environment variable overrides.
/// </summary>
public static class OpenClawEnv
{
    // Reads an env var, trims whitespace, returns null if unset or empty.
    public static string? Path(string key)
    {
        var raw = Environment.GetEnvironmentVariable(key);
        if (raw is null) return null;
        var trimmed = raw.Trim();
        return trimmed.Length == 0 ? null : trimmed;
    }
}

/// <summary>
/// Canonical path constants for the OpenClaw Windows app.
/// %LOCALAPPDATA%\OpenClaw\ on Windows.
/// </summary>
public static class OpenClawPaths
{
    // Env var keys — arrays mirror Swift in case more overrides are added later
    private static readonly string[] ConfigPathEnvKeys = ["OPENCLAW_CONFIG_PATH"];
    private static readonly string[] StateDirEnvKeys   = ["OPENCLAW_STATE_DIR"];

    // Root state directory.
    // Env override: OPENCLAW_STATE_DIR
    // Default:      %LOCALAPPDATA%\OpenClaw\
    public static string StateDirPath
    {
        get
        {
            foreach (var key in StateDirEnvKeys)
            {
                var override_ = OpenClawEnv.Path(key);
                if (override_ is not null) return override_;
            }

            return System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OpenClaw");
        }
    }

    // Path to openclaw.json.
    // Env override: OPENCLAW_CONFIG_PATH
    // Otherwise:    checks for existing openclaw.json in StateDirPath,
    //               falls back to StateDirPath\openclaw.json
    public static string ConfigPath
    {
        get
        {
            foreach (var key in ConfigPathEnvKeys)
            {
                var override_ = OpenClawEnv.Path(key);
                if (override_ is not null) return override_;
            }

            var stateDir = StateDirPath;
            var candidate = ResolveConfigCandidate(stateDir);
            return candidate ?? System.IO.Path.Combine(stateDir, "openclaw.json");
        }
    }

    // Default workspace directory
    public static string WorkspacePath
        => System.IO.Path.Combine(StateDirPath, "workspace");

    // Looks for openclaw.json inside dir
    private static string? ResolveConfigCandidate(string dir)
    {
        var candidate = System.IO.Path.Combine(dir, "openclaw.json");
        return File.Exists(candidate) ? candidate : null;
    }
}
