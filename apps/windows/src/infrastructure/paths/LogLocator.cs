namespace OpenClawWindows.Infrastructure.Paths;

/// <summary>
/// Locates log files for the OpenClaw gateway and host service.
/// Uses %TEMP%\openclaw as the log directory;
/// launchd log properties map to Windows service log path properties.
/// </summary>
public static class LogLocator
{
    private static string LogDir
    {
        get
        {
            var override_ = OpenClawEnv.Path("OPENCLAW_LOG_DIR");
            if (override_ is not null) return override_;
            return Path.Combine(Path.GetTempPath(), "openclaw");
        }
    }

    private static string StdoutLog => Path.Combine(LogDir, "openclaw-stdout.log");
    private static string GatewayLog => Path.Combine(LogDir, "openclaw-gateway.log");

    private static void EnsureLogDirExists()
    {
        // best-effort:
        try { Directory.CreateDirectory(LogDir); }
        catch { }
    }

    private static DateTime ModificationDate(string path) =>
        File.Exists(path) ? File.GetLastWriteTimeUtc(path) : DateTime.MinValue;

    /// Returns the newest OpenClaw log under the log directory, or null if none exist.
    public static string? BestLogFile()
    {
        EnsureLogDirExists();
        var dir = LogDir;
        if (!Directory.Exists(dir)) return null;

        try
        {
            return Directory.EnumerateFiles(dir)
                .Where(f =>
                {
                    var name = Path.GetFileName(f);
                    return name.StartsWith("openclaw", StringComparison.OrdinalIgnoreCase)
                        && Path.GetExtension(f).Equals(".log", StringComparison.OrdinalIgnoreCase);
                })
                .OrderByDescending(ModificationDate)
                .FirstOrDefault();
        }
        catch { return null; }
    }

    // Path for the Windows service stdout/stderr log. Ensures the log directory exists.
    public static string ServiceLogPath
    {
        get
        {
            EnsureLogDirExists();
            return StdoutLog;
        }
    }

    // Path for the gateway service stdout/stderr log. Ensures the log directory exists.
    public static string ServiceGatewayLogPath
    {
        get
        {
            EnsureLogDirExists();
            return GatewayLog;
        }
    }
}
