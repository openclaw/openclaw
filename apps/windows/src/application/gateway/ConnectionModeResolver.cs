using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Gateway;

internal enum EffectiveConnectionModeSource
{
    ConfigMode,
    ConfigRemoteUrl,
    UserDefaults,
    Onboarding,
}

internal sealed record EffectiveConnectionMode(
    ConnectionMode Mode,
    EffectiveConnectionModeSource Source);

/// <summary>
/// Pure resolution of the effective connection mode from config file and persisted settings.
/// </summary>
internal static class ConnectionModeResolver
{
    // Not used as a raw key here — Windows reads the typed ConnectionMode from AppSettings.
    // Retained as documentation of the origin.

    internal static EffectiveConnectionMode Resolve(
        Dictionary<string, object?> root,
        AppSettings settings)
    {
        // Step 1 — gateway.mode in config file overrides everything
        var gateway = AsDict(root, "gateway");
        var configMode = (gateway?.GetValueOrDefault("mode") as string ?? "")
            .Trim()
            .ToLowerInvariant();

        if (configMode == "local")
            return new EffectiveConnectionMode(ConnectionMode.Local, EffectiveConnectionModeSource.ConfigMode);
        if (configMode == "remote")
            return new EffectiveConnectionMode(ConnectionMode.Remote, EffectiveConnectionModeSource.ConfigMode);

        // Step 2 — gateway.remote.url present → implicit remote
        var remote = gateway is not null ? AsDict(gateway, "remote") : null;
        var remoteUrl = (remote?.GetValueOrDefault("url") as string ?? "").Trim();
        if (remoteUrl.Length > 0)
            return new EffectiveConnectionMode(ConnectionMode.Remote, EffectiveConnectionModeSource.ConfigRemoteUrl);

        // Step 3 — user's persisted choice
        // Unconfigured is the "never written" sentinel — skip it to fall through to onboarding
        if (settings.ConnectionMode != ConnectionMode.Unconfigured)
            return new EffectiveConnectionMode(settings.ConnectionMode, EffectiveConnectionModeSource.UserDefaults);

        // Step 4 — onboarding gate
        var mode = settings.OnboardingSeen ? ConnectionMode.Local : ConnectionMode.Unconfigured;
        return new EffectiveConnectionMode(mode, EffectiveConnectionModeSource.Onboarding);
    }

    private static Dictionary<string, object?>? AsDict(Dictionary<string, object?> root, string key)
        => root.GetValueOrDefault(key) as Dictionary<string, object?>;
}
