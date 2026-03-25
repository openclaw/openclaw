using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Gateway;

// Mirrors GatewayEndpointStoreTests.swift — covers static resolution helpers.
// launchd plist fallback is omitted on Windows (no launchd); config-file fallback is tested instead.
public sealed class GatewayEndpointStoreTests
{
    // ── ResolveGatewayToken ───────────────────────────────────────────────────

    [Fact]
    public void ResolveGatewayToken_PrefersEnvOverConfig()
    {
        var root = new Dictionary<string, object?>
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["auth"] = new Dictionary<string, object?> { ["token"] = "config-token" },
            },
        };

        var token = GatewayEndpointStore.ResolveGatewayToken(
            isRemote: false,
            root: root,
            env: new Dictionary<string, string> { ["OPENCLAW_GATEWAY_TOKEN"] = "env-token" });

        Assert.Equal("env-token", token);
    }

    [Fact]
    public void ResolveGatewayToken_FallsBackToConfigToken()
    {
        var root = new Dictionary<string, object?>
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["auth"] = new Dictionary<string, object?> { ["token"] = "  config-token  " },
            },
        };

        var token = GatewayEndpointStore.ResolveGatewayToken(
            isRemote: false,
            root: root,
            env: new Dictionary<string, string>());

        // Mirrors Swift: trimmingCharacters(in: .whitespacesAndNewlines)
        Assert.Equal("config-token", token);
    }

    [Fact]
    public void ResolveGatewayToken_Remote_IgnoresLocalAuth()
    {
        // Mirrors Swift: isRemote=true ignores gateway.auth.token (and launchd)
        var root = new Dictionary<string, object?>
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["auth"] = new Dictionary<string, object?> { ["token"] = "local-token" },
            },
        };

        var token = GatewayEndpointStore.ResolveGatewayToken(
            isRemote: true,
            root: root,
            env: new Dictionary<string, string>());

        Assert.Null(token);
    }

    [Fact]
    public void ResolveGatewayToken_Remote_UsesRemoteConfigToken()
    {
        // Mirrors resolveGatewayTokenUsesRemoteConfigToken Swift test
        var root = new Dictionary<string, object?>
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["remote"] = new Dictionary<string, object?> { ["token"] = "  remote-token  " },
            },
        };

        var token = GatewayEndpointStore.ResolveGatewayToken(
            isRemote: true,
            root: root,
            env: new Dictionary<string, string>());

        Assert.Equal("remote-token", token);
    }

    // ── ResolveGatewayPassword ────────────────────────────────────────────────

    [Fact]
    public void ResolveGatewayPassword_FallsBackToConfigPassword()
    {
        // Mirrors resolveGatewayPasswordFallsBackToLaunchd — on Windows the fallback is config
        var root = new Dictionary<string, object?>
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["auth"] = new Dictionary<string, object?> { ["password"] = "config-pass" },
            },
        };

        var password = GatewayEndpointStore.ResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: new Dictionary<string, string>());

        Assert.Equal("config-pass", password);
    }

    [Fact]
    public void ResolveGatewayPassword_PrefersEnv()
    {
        var root = new Dictionary<string, object?>();

        var password = GatewayEndpointStore.ResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: new Dictionary<string, string> { ["OPENCLAW_GATEWAY_PASSWORD"] = "env-pass" });

        Assert.Equal("env-pass", password);
    }

    // ── ResolveLocalGatewayHost ───────────────────────────────────────────────

    [Fact]
    public void ResolveLocalGatewayHost_Auto_ReturnsLoopbackEvenWithTailnet()
    {
        var host = GatewayEndpointStore.ResolveLocalGatewayHost(
            bindMode: "auto",
            customBindHost: null,
            tailscaleIP: "100.64.1.2");
        Assert.Equal("127.0.0.1", host);
    }

    [Fact]
    public void ResolveLocalGatewayHost_Auto_ReturnsLoopbackWithoutTailnet()
    {
        var host = GatewayEndpointStore.ResolveLocalGatewayHost(
            bindMode: "auto",
            customBindHost: null,
            tailscaleIP: null);
        Assert.Equal("127.0.0.1", host);
    }

    [Fact]
    public void ResolveLocalGatewayHost_Tailnet_PrefersTailscaleIP()
    {
        var host = GatewayEndpointStore.ResolveLocalGatewayHost(
            bindMode: "tailnet",
            customBindHost: null,
            tailscaleIP: "100.64.1.5");
        Assert.Equal("100.64.1.5", host);
    }

    [Fact]
    public void ResolveLocalGatewayHost_Tailnet_FallsBackToLoopback()
    {
        var host = GatewayEndpointStore.ResolveLocalGatewayHost(
            bindMode: "tailnet",
            customBindHost: null,
            tailscaleIP: null);
        Assert.Equal("127.0.0.1", host);
    }

    [Fact]
    public void ResolveLocalGatewayHost_Custom_ReturnsCustomHost()
    {
        var host = GatewayEndpointStore.ResolveLocalGatewayHost(
            bindMode: "custom",
            customBindHost: "192.168.1.10",
            tailscaleIP: "100.64.1.9");
        Assert.Equal("192.168.1.10", host);
    }

    // ── LocalConfig ───────────────────────────────────────────────────────────

    [Fact]
    public void LocalConfig_UsesLocalAuthAndHostResolution()
    {
        // Mirrors local config uses local gateway auth and host resolution Swift test
        var root = new Dictionary<string, object?>
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["bind"] = "tailnet",
                ["tls"]  = new Dictionary<string, object?> { ["enabled"] = true },
                ["auth"] = new Dictionary<string, object?>
                {
                    ["token"]    = "local-token",
                    ["password"] = "local-pass",
                },
                ["remote"] = new Dictionary<string, object?>
                {
                    ["url"]   = "wss://remote.example:443",
                    ["token"] = "remote-token",
                },
            },
        };

        var config = GatewayEndpointStore.LocalConfig(
            root: root,
            env: new Dictionary<string, string>(),
            tailscaleIP: "100.64.1.8");

        // C# Uri normalizes authority-only URIs with a trailing slash; functional parity with Swift
        Assert.Equal("wss://100.64.1.8:18789/", config.Url.AbsoluteUri);
        Assert.Equal("local-token", config.Token);
        Assert.Equal("local-pass", config.Password);
    }

    // ── DashboardUrl ──────────────────────────────────────────────────────────

    [Fact]
    public void DashboardUrl_Local_UsesBasePath()
    {
        var config = new GatewayEndpointConfig(new Uri("ws://127.0.0.1:18789"), null, null);

        var url = GatewayEndpointStore.DashboardUrl(config, ConnectionMode.Local, localBasePath: " control ");

        Assert.Equal("http://127.0.0.1:18789/control/", url.AbsoluteUri);
    }

    [Fact]
    public void DashboardUrl_Remote_SkipsLocalBasePath()
    {
        var config = new GatewayEndpointConfig(new Uri("ws://gateway.example:18789"), null, null);

        var url = GatewayEndpointStore.DashboardUrl(config, ConnectionMode.Remote, localBasePath: "/local-ui");

        Assert.Equal("http://gateway.example:18789/", url.AbsoluteUri);
    }

    [Fact]
    public void DashboardUrl_PrefersPathFromConfigUrl()
    {
        var config = new GatewayEndpointConfig(new Uri("wss://gateway.example:443/remote-ui"), null, null);

        var url = GatewayEndpointStore.DashboardUrl(config, ConnectionMode.Remote, localBasePath: "/local-ui");

        // C# Uri.AbsoluteUri strips default ports (443 for https); functionally identical to Swift
        Assert.Equal("https://gateway.example/remote-ui/", url.AbsoluteUri);
    }

    [Fact]
    public void DashboardUrl_IncludesTokenInFragmentAndOmitsPassword()
    {
        var config = new GatewayEndpointConfig(
            new Uri("ws://127.0.0.1:18789"),
            Token: "abc123",
            Password: "sekret"); // password must NOT appear in URL

        var url = GatewayEndpointStore.DashboardUrl(config, ConnectionMode.Local, localBasePath: "/control");

        Assert.Equal("http://127.0.0.1:18789/control/#token=abc123", url.AbsoluteUri);
        Assert.Null(url.Query == "" ? null : url.Query);
    }

    // ── NormalizeDashboardPath ────────────────────────────────────────────────

    [Fact]
    public void NormalizeDashboardPath_Null_ReturnsSlash()
        => Assert.Equal("/", GatewayEndpointStore.NormalizeDashboardPath(null));

    [Fact]
    public void NormalizeDashboardPath_EmptyString_ReturnsSlash()
        => Assert.Equal("/", GatewayEndpointStore.NormalizeDashboardPath(""));

    [Fact]
    public void NormalizeDashboardPath_AddsLeadingAndTrailingSlash()
        => Assert.Equal("/control/", GatewayEndpointStore.NormalizeDashboardPath("control"));

    [Fact]
    public void NormalizeDashboardPath_PreservesExistingSlashes()
        => Assert.Equal("/ui/dashboard/", GatewayEndpointStore.NormalizeDashboardPath("/ui/dashboard"));
}
