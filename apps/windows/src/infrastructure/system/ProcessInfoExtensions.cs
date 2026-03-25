namespace OpenClawWindows.Infrastructure.Lifecycle;

/// <summary>
/// Process environment utilities.
/// </summary>
internal static class ProcessInfoExtensions
{
    /// <summary>
    /// Testable core of IsNixMode — reads OPENCLAW_NIX_MODE from the given environment map.
    /// </summary>
    internal static bool ResolveNixMode(IReadOnlyDictionary<string, string> environment)
        => environment.TryGetValue("OPENCLAW_NIX_MODE", out var v) && v == "1";

    // isAppBundle + stableSuite paths dropped — no UserDefaults or launchd on Windows.
    internal static bool IsNixMode => ResolveNixMode(CurrentEnvironment());

    internal static bool IsPreview
    {
        get
        {
            // Primary: XCODE_RUNNING_FOR_PREVIEWS == "1"
            if (Environment.GetEnvironmentVariable("XCODE_RUNNING_FOR_PREVIEWS") == "1")
                return true;

            // Windows-specific: WinUI 3 XAML designer mode — no Swift equivalent
            try { return Windows.ApplicationModel.DesignMode.DesignModeEnabled; }
            catch { return false; }
        }
    }

    internal static bool IsRunningTests
    {
        get
        {
            // Check for xunit runner assembly
            if (AppDomain.CurrentDomain.GetAssemblies()
                    .Any(a => a.GetName().Name?.StartsWith("xunit", StringComparison.OrdinalIgnoreCase) == true))
                return true;

            // XCTest env var fallbacks
            var env = CurrentEnvironment();
            return env.ContainsKey("XCTestConfigurationFilePath")
                || env.ContainsKey("XCTestBundlePath")
                || env.ContainsKey("XCTestSessionIdentifier");
        }
    }

    private static IReadOnlyDictionary<string, string> CurrentEnvironment()
    {
        var raw = Environment.GetEnvironmentVariables();
        var result = new Dictionary<string, string>(raw.Count, StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry entry in raw)
            result[entry.Key.ToString()!] = entry.Value?.ToString() ?? string.Empty;
        return result;
    }
}
