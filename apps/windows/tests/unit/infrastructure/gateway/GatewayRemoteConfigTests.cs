using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Gateway;

public sealed class GatewayRemoteConfigTests
{
    // ── NormalizeGatewayUrl ───────────────────────────────────────────────────
    // Mirrors Swift: GatewayRemoteConfig.normalizeGatewayUrl

    [Theory]
    [InlineData("ws://localhost",          "ws://localhost:18789/")]    // ws loopback — inject default port
    [InlineData("ws://localhost:8080",     "ws://localhost:8080/")]     // ws loopback — keep explicit port
    [InlineData("ws://127.0.0.1",          "ws://127.0.0.1:18789/")]   // ws IPv4 loopback
    [InlineData("ws://[::1]",              "ws://[::1]:18789/")]        // ws IPv6 loopback
    [InlineData("ws://localhost:18789",    "ws://localhost:18789/")]    // ws explicit default port
    [InlineData("wss://example.com",       "wss://example.com/")]       // wss non-loopback allowed
    [InlineData("wss://example.com:4443",  "wss://example.com:4443/")]  // wss explicit port
    [InlineData("wss://192.168.1.1",       "wss://192.168.1.1/")]       // wss LAN allowed
    public void NormalizeGatewayUrl_ValidInputs_ReturnsExpectedUri(string input, string expected)
    {
        var result = GatewayRemoteConfig.NormalizeGatewayUrl(input);
        Assert.NotNull(result);
        Assert.Equal(expected, result!.AbsoluteUri);
    }

    [Theory]
    [InlineData("ws://example.com")]     // ws non-loopback rejected
    [InlineData("ws://192.168.1.1")]     // ws LAN rejected
    [InlineData("http://localhost")]      // wrong scheme
    [InlineData("https://localhost")]     // wrong scheme
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-url")]
    [InlineData("ws://")]                 // no host
    public void NormalizeGatewayUrl_InvalidInputs_ReturnsNull(string input)
    {
        Assert.Null(GatewayRemoteConfig.NormalizeGatewayUrl(input));
    }

    [Fact]
    public void NormalizeGatewayUrl_WhitespacePadded_AcceptsValidUrl()
    {
        var result = GatewayRemoteConfig.NormalizeGatewayUrl("  ws://localhost  ");
        Assert.NotNull(result);
    }

    // ── NormalizeGatewayUrlString ─────────────────────────────────────────────

    [Fact]
    public void NormalizeGatewayUrlString_Valid_ReturnsAbsoluteString()
    {
        Assert.Equal("ws://localhost:18789/", GatewayRemoteConfig.NormalizeGatewayUrlString("ws://localhost"));
    }

    [Fact]
    public void NormalizeGatewayUrlString_Invalid_ReturnsNull()
    {
        Assert.Null(GatewayRemoteConfig.NormalizeGatewayUrlString("http://localhost"));
    }

    // ── ResolveTransport ──────────────────────────────────────────────────────

    [Fact]
    public void ResolveTransport_DirectValue_ReturnsDirect()
    {
        Assert.Equal(RemoteTransport.Direct, GatewayRemoteConfig.ResolveTransport(MakeRoot("direct")));
    }

    [Theory]
    [InlineData("DIRECT")]
    [InlineData("  direct  ")]
    [InlineData("Direct")]
    public void ResolveTransport_DirectVariants_ReturnsDirect(string transport)
    {
        Assert.Equal(RemoteTransport.Direct, GatewayRemoteConfig.ResolveTransport(MakeRoot(transport)));
    }

    [Theory]
    [InlineData("ssh")]
    [InlineData("SSH")]
    [InlineData("other")]
    [InlineData("")]
    public void ResolveTransport_NonDirect_ReturnsSsh(string transport)
    {
        Assert.Equal(RemoteTransport.Ssh, GatewayRemoteConfig.ResolveTransport(MakeRoot(transport)));
    }

    [Fact]
    public void ResolveTransport_MissingKeys_ReturnsSsh()
    {
        Assert.Equal(RemoteTransport.Ssh, GatewayRemoteConfig.ResolveTransport([]));
    }

    // ── ResolveUrlString ──────────────────────────────────────────────────────

    [Fact]
    public void ResolveUrlString_ValidUrl_ReturnsUrl()
    {
        Assert.Equal("ws://localhost:8080", GatewayRemoteConfig.ResolveUrlString(MakeRoot(url: "ws://localhost:8080")));
    }

    [Fact]
    public void ResolveUrlString_TrimsWhitespace()
    {
        Assert.Equal("ws://localhost", GatewayRemoteConfig.ResolveUrlString(MakeRoot(url: "  ws://localhost  ")));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ResolveUrlString_EmptyOrWhitespace_ReturnsNull(string url)
    {
        Assert.Null(GatewayRemoteConfig.ResolveUrlString(MakeRoot(url: url)));
    }

    [Fact]
    public void ResolveUrlString_MissingKeys_ReturnsNull()
    {
        Assert.Null(GatewayRemoteConfig.ResolveUrlString([]));
    }

    // ── ResolveGatewayUrl ─────────────────────────────────────────────────────

    [Fact]
    public void ResolveGatewayUrl_ValidRoot_ReturnsNormalizedUri()
    {
        var result = GatewayRemoteConfig.ResolveGatewayUrl(MakeRoot(url: "ws://localhost"));
        Assert.NotNull(result);
        Assert.Equal(18789, result!.Port);
    }

    [Fact]
    public void ResolveGatewayUrl_NonLoopbackWs_ReturnsNull()
    {
        Assert.Null(GatewayRemoteConfig.ResolveGatewayUrl(MakeRoot(url: "ws://example.com")));
    }

    // ── DefaultPort ───────────────────────────────────────────────────────────

    [Fact]
    public void DefaultPort_ExplicitPort_ReturnsThatPort()
    {
        Assert.Equal(8080, GatewayRemoteConfig.DefaultPort(new Uri("ws://localhost:8080")));
    }

    [Fact]
    public void DefaultPort_WsWithoutPort_Returns18789()
    {
        Assert.Equal(18789, GatewayRemoteConfig.DefaultPort(new Uri("ws://localhost")));
    }

    [Fact]
    public void DefaultPort_WssWithoutPort_Returns443()
    {
        Assert.Equal(443, GatewayRemoteConfig.DefaultPort(new Uri("wss://example.com")));
    }

    // ── LoopbackHost ──────────────────────────────────────────────────────────
    // Mirrors Swift: LoopbackHost.isLoopbackHost

    [Theory]
    [InlineData("localhost")]
    [InlineData("LOCALHOST")]
    [InlineData("127.0.0.1")]
    [InlineData("127.0.0.99")]
    [InlineData("0.0.0.0")]
    [InlineData("::")]
    [InlineData("[::1]")]
    [InlineData("::1")]
    [InlineData("::ffff:127.0.0.1")]
    public void LoopbackHost_IsLoopbackHost_KnownLoopbacks(string host)
    {
        Assert.True(LoopbackHost.IsLoopbackHost(host));
    }

    [Theory]
    [InlineData("example.com")]
    [InlineData("192.168.1.1")]
    [InlineData("10.0.0.1")]
    [InlineData("8.8.8.8")]
    [InlineData("")]
    [InlineData("   ")]
    public void LoopbackHost_IsLoopbackHost_NonLoopbacks(string host)
    {
        Assert.False(LoopbackHost.IsLoopbackHost(host));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static Dictionary<string, object?> MakeRoot(string? transport = null, string? url = null)
    {
        var remote = new Dictionary<string, object?>();
        if (transport is not null) remote["transport"] = transport;
        if (url is not null) remote["url"] = url;
        if (remote.Count == 0) return [];
        return new Dictionary<string, object?>
        {
            ["gateway"] = new Dictionary<string, object?> { ["remote"] = remote },
        };
    }
}
