using OpenClawWindows.Application.Ports;
using Windows.ApplicationModel;

namespace OpenClawWindows.Infrastructure.Updates;

// returns DisabledUpdaterController for developer builds, MsixUpdaterController otherwise.
internal static class UpdaterControllerFactory
{
    private const string AutoUpdateKey = "OpenClaw_AutoUpdateEnabled";

    internal static IUpdaterController Create(IServiceProvider sp)
    {
        // Developer-signed packages get the no-op controller — matches macOS
        // isDeveloperIDSigned check that guards SparkleUpdaterController creation.
        if (IsDeveloperSigned())
            return new DisabledUpdaterController();

        var savedAutoUpdate = ReadAutoUpdateSetting();
        return new MsixUpdaterController(
            savedAutoUpdate,
            sp.GetRequiredService<ILogger<MsixUpdaterController>>());
    }

    internal static void SaveAutoUpdateSetting(bool enabled)
    {
        try
        {
            var local = Windows.Storage.ApplicationData.Current.LocalSettings;
            local.Values[AutoUpdateKey] = enabled;
        }
        catch { /* non-fatal */ }
    }

    private static bool ReadAutoUpdateSetting()
    {
        try
        {
            var local = Windows.Storage.ApplicationData.Current.LocalSettings;
            return local.Values.TryGetValue(AutoUpdateKey, out var v) ? v is true : true;
        }
        catch { return true; }
    }

    private static bool IsDeveloperSigned()
    {
        try { return Package.Current.SignatureKind == PackageSignatureKind.Developer; }
        catch { return true; } // if Package.Current throws we're outside MSIX → treat as dev
    }
}
