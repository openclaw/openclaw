using OpenClawWindows.Infrastructure.Settings;

namespace OpenClawWindows.Tests.Unit.Infrastructure;

public sealed class UserDefaultsMigrationTests
{
    [Fact]
    public void MigrateLegacyDefaults_DoesNotThrow()
    {
        // Swift migrateLegacyDefaults() is a no-op (both prefixes are "openclaw.").
        // Verifying the Windows equivalent is also safe to call unconditionally.
        var ex = Record.Exception(UserDefaultsMigration.MigrateLegacyDefaults);
        Assert.Null(ex);
    }

    [Fact]
    public void MigrateLegacyDefaults_IsIdempotent()
    {
        // Multiple calls must remain safe — mirrors Swift UserDefaults nil-guard behavior.
        var ex = Record.Exception(() =>
        {
            UserDefaultsMigration.MigrateLegacyDefaults();
            UserDefaultsMigration.MigrateLegacyDefaults();
        });
        Assert.Null(ex);
    }
}
