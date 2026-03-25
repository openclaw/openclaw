using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Tests.Unit.Application.Gateway;

public sealed class ConnectionModeResolverTests
{
    private static AppSettings DefaultSettings()
        => AppSettings.WithDefaults(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));

    // ── Step 1: gateway.mode = "local" / "remote" in config ──────────────────

    [Fact]
    public void Resolve_ConfigModeLocal_ReturnsLocalFromConfig()
    {
        var root = GatewayRoot("mode", "local");
        var result = ConnectionModeResolver.Resolve(root, DefaultSettings());
        Assert.Equal(ConnectionMode.Local, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.ConfigMode, result.Source);
    }

    [Fact]
    public void Resolve_ConfigModeRemote_ReturnsRemoteFromConfig()
    {
        var root = GatewayRoot("mode", "remote");
        var result = ConnectionModeResolver.Resolve(root, DefaultSettings());
        Assert.Equal(ConnectionMode.Remote, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.ConfigMode, result.Source);
    }

    [Theory]
    [InlineData("LOCAL")]
    [InlineData("  local  ")]
    [InlineData("REMOTE")]
    [InlineData("  remote ")]
    public void Resolve_ConfigModeIsCaseAndWhitespaceInsensitive(string raw)
    {
        // Swift: .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var root = GatewayRoot("mode", raw);
        var result = ConnectionModeResolver.Resolve(root, DefaultSettings());
        Assert.Equal(EffectiveConnectionModeSource.ConfigMode, result.Source);
    }

    [Theory]
    [InlineData("")]
    [InlineData("auto")]
    [InlineData("unknown")]
    public void Resolve_ConfigModeUnrecognized_FallsThrough(string raw)
    {
        var root = GatewayRoot("mode", raw);
        // No remote URL, settings default Unconfigured, onboarding not seen → Unconfigured/Onboarding
        var result = ConnectionModeResolver.Resolve(root, DefaultSettings());
        Assert.NotEqual(EffectiveConnectionModeSource.ConfigMode, result.Source);
    }

    // ── Step 2: gateway.remote.url present ───────────────────────────────────

    [Fact]
    public void Resolve_RemoteUrlPresent_ReturnsRemoteFromConfigRemoteUrl()
    {
        var root = RootWithRemoteUrl("ws://gateway.example.com:18789");
        var result = ConnectionModeResolver.Resolve(root, DefaultSettings());
        Assert.Equal(ConnectionMode.Remote, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.ConfigRemoteUrl, result.Source);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Resolve_RemoteUrlEmptyOrWhitespace_FallsThrough(string url)
    {
        var root = RootWithRemoteUrl(url);
        var result = ConnectionModeResolver.Resolve(root, DefaultSettings());
        Assert.NotEqual(EffectiveConnectionModeSource.ConfigRemoteUrl, result.Source);
    }

    [Fact]
    public void Resolve_ConfigModeRemote_WinsOverRemoteUrl()
    {
        // Swift: switch configMode { case "remote": return ... } is evaluated before remoteURL check
        var root = RootWithRemoteUrl("ws://gateway.example.com:18789");
        (root["gateway"] as Dictionary<string, object?>)!["mode"] = "local";
        var result = ConnectionModeResolver.Resolve(root, DefaultSettings());
        Assert.Equal(ConnectionMode.Local, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.ConfigMode, result.Source);
    }

    // ── Step 3: persisted settings (UserDefaults equivalent) ─────────────────

    [Fact]
    public void Resolve_SettingsLocal_ReturnsLocalFromUserDefaults()
    {
        var settings = DefaultSettings();
        settings.SetConnectionMode(ConnectionMode.Local);

        var result = ConnectionModeResolver.Resolve([], settings);
        Assert.Equal(ConnectionMode.Local, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.UserDefaults, result.Source);
    }

    [Fact]
    public void Resolve_SettingsRemote_ReturnsRemoteFromUserDefaults()
    {
        var settings = DefaultSettings();
        settings.SetConnectionMode(ConnectionMode.Remote);

        var result = ConnectionModeResolver.Resolve([], settings);
        Assert.Equal(ConnectionMode.Remote, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.UserDefaults, result.Source);
    }

    [Fact]
    public void Resolve_SettingsUnconfigured_FallsThroughToOnboarding()
    {
        // Unconfigured == "never written" sentinel — must not be treated as explicit UserDefaults value
        var settings = DefaultSettings(); // ConnectionMode defaults to Unconfigured
        var result = ConnectionModeResolver.Resolve([], settings);
        Assert.Equal(EffectiveConnectionModeSource.Onboarding, result.Source);
    }

    // ── Step 4: onboarding gate ───────────────────────────────────────────────

    [Fact]
    public void Resolve_OnboardingNotSeen_ReturnsUnconfigured()
    {
        // Swift: let seen = defaults.bool(forKey: "openclaw.onboardingSeen")
        //        return seen ? .local : .unconfigured
        var settings = DefaultSettings(); // OnboardingSeen = false
        var result = ConnectionModeResolver.Resolve([], settings);
        Assert.Equal(ConnectionMode.Unconfigured, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.Onboarding, result.Source);
    }

    [Fact]
    public void Resolve_OnboardingSeen_ReturnsLocal()
    {
        var settings = DefaultSettings();
        settings.SetOnboardingSeen(true);

        var result = ConnectionModeResolver.Resolve([], settings);
        Assert.Equal(ConnectionMode.Local, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.Onboarding, result.Source);
    }

    // ── Priority order: config > remoteURL > userDefaults > onboarding ────────

    [Fact]
    public void Resolve_ConfigModeTakesPriorityOverAllOtherSources()
    {
        var root = RootWithRemoteUrl("ws://gateway.example.com:18789");
        (root["gateway"] as Dictionary<string, object?>)!["mode"] = "remote";

        var settings = DefaultSettings();
        settings.SetConnectionMode(ConnectionMode.Local);
        settings.SetOnboardingSeen(true);

        var result = ConnectionModeResolver.Resolve(root, settings);
        Assert.Equal(EffectiveConnectionModeSource.ConfigMode, result.Source);
    }

    [Fact]
    public void Resolve_RemoteUrlTakesPriorityOverUserDefaults()
    {
        var root = RootWithRemoteUrl("ws://gateway.example.com:18789");
        var settings = DefaultSettings();
        settings.SetConnectionMode(ConnectionMode.Local);

        var result = ConnectionModeResolver.Resolve(root, settings);
        Assert.Equal(EffectiveConnectionModeSource.ConfigRemoteUrl, result.Source);
    }

    // ── Edge cases ────────────────────────────────────────────────────────────

    [Fact]
    public void Resolve_EmptyRoot_NoSettings_ReturnsUnconfiguredFromOnboarding()
    {
        var result = ConnectionModeResolver.Resolve([], DefaultSettings());
        Assert.Equal(ConnectionMode.Unconfigured, result.Mode);
        Assert.Equal(EffectiveConnectionModeSource.Onboarding, result.Source);
    }

    [Fact]
    public void Resolve_MissingGatewaySection_DoesNotThrow()
    {
        var root = new Dictionary<string, object?> { ["other"] = "value" };
        var result = ConnectionModeResolver.Resolve(root, DefaultSettings());
        Assert.Equal(EffectiveConnectionModeSource.Onboarding, result.Source);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static Dictionary<string, object?> GatewayRoot(string key, string value)
        => new() { ["gateway"] = new Dictionary<string, object?> { [key] = value } };

    private static Dictionary<string, object?> RootWithRemoteUrl(string url)
    {
        var remote  = new Dictionary<string, object?> { ["url"] = url };
        var gateway = new Dictionary<string, object?> { ["remote"] = remote };
        return new Dictionary<string, object?> { ["gateway"] = gateway };
    }
}
