namespace OpenClawWindows.Infrastructure.Settings;

// In Swift, legacyDefaultsPrefix and defaultsPrefix are both "openclaw." (identical),
// so migrateLegacyDefaults() is a no-op. This class preserves that contract.
internal static class UserDefaultsMigration
{
    // Tunables
    private const string LegacySettingsPrefix = "openclaw.";
    private const string SettingsPrefix = "openclaw.";

    internal static void MigrateLegacyDefaults()
    {
        // No-op: LegacySettingsPrefix == SettingsPrefix, matching Swift source exactly.
        // Windows uses JSON-backed settings (not UserDefaults), so no key enumeration needed.
        _ = LegacySettingsPrefix;
        _ = SettingsPrefix;
    }
}
