using OpenClawWindows.Application.DeepLinks;
using OpenClawWindows.Domain.DeepLinks;

namespace OpenClawWindows.Tests.Unit.Application.DeepLinks;

// Tests for DeepLinkParser (URL routing) and GatewayConnectDeepLink (setup-code parsing).
// All security-critical paths are covered: scheme validation, non-TLS loopback enforcement,
// setup code rejection, and query field validation.
public sealed class DeepLinkParserTests
{
    // ── Wrong scheme — must return null ───────────────────────────────────────

    [Theory]
    [InlineData("https://agent?message=hi")]
    [InlineData("http://agent?message=hi")]
    [InlineData("ftp://agent?message=hi")]
    [InlineData("file://agent?message=hi")]
    public void Parse_NonOpenClawScheme_ReturnsNull(string url)
    {
        // Any scheme other than "openclaw" must be rejected outright —
        // prevents other URL handlers from being confused with deep links.
        DeepLinkParser.Parse(new Uri(url)).Should().BeNull();
    }

    [Fact]
    public void Parse_OpenClawScheme_CaseInsensitive()
    {
        // "OPENCLAW" must be accepted — Windows shell may normalise scheme case.
        var url = new Uri("OPENCLAW://agent?message=hello");
        DeepLinkParser.Parse(url).Should().NotBeNull();
    }

    // ── Unknown host — must return null ───────────────────────────────────────

    [Theory]
    [InlineData("openclaw://unknown?message=hi")]
    [InlineData("openclaw://run?message=hi")]
    [InlineData("openclaw://exec?cmd=ls")]
    public void Parse_UnknownHost_ReturnsNull(string url)
    {
        DeepLinkParser.Parse(new Uri(url)).Should().BeNull();
    }

    // ── openclaw://agent ──────────────────────────────────────────────────────

    [Fact]
    public void Parse_AgentWithMessage_ReturnsAgentRoute()
    {
        var url    = new Uri("openclaw://agent?message=hello+world");
        var result = DeepLinkParser.Parse(url);

        result.Should().BeOfType<DeepLinkParser.AgentRoute>();
        var route = (DeepLinkParser.AgentRoute)result!;
        route.Link.Message.Should().Be("hello world");
    }

    [Fact]
    public void Parse_AgentMissingMessage_ReturnsNull()
    {
        // A message-less agent deep link has no meaningful payload — reject.
        DeepLinkParser.Parse(new Uri("openclaw://agent?sessionKey=abc"))
            .Should().BeNull("agent route requires a non-empty message");
    }

    [Fact]
    public void Parse_AgentWhitespaceMessage_ReturnsNull()
    {
        DeepLinkParser.Parse(new Uri("openclaw://agent?message=+++"))
            .Should().BeNull("whitespace-only message must be rejected");
    }

    [Fact]
    public void Parse_AgentDeliverTrue_ParsedCorrectly()
    {
        var url    = new Uri("openclaw://agent?message=hi&deliver=true");
        var result = (DeepLinkParser.AgentRoute)DeepLinkParser.Parse(url)!;
        result.Link.Deliver.Should().BeTrue();
    }

    [Fact]
    public void Parse_AgentDeliverOne_ParsedAsTrue()
    {
        var url    = new Uri("openclaw://agent?message=hi&deliver=1");
        var result = (DeepLinkParser.AgentRoute)DeepLinkParser.Parse(url)!;
        result.Link.Deliver.Should().BeTrue();
    }

    [Fact]
    public void Parse_AgentDeliverAbsent_ParsedAsFalse()
    {
        var url    = new Uri("openclaw://agent?message=hi");
        var result = (DeepLinkParser.AgentRoute)DeepLinkParser.Parse(url)!;
        result.Link.Deliver.Should().BeFalse();
    }

    [Fact]
    public void Parse_AgentPositiveTimeoutSeconds_Parsed()
    {
        var url    = new Uri("openclaw://agent?message=hi&timeoutSeconds=30");
        var result = (DeepLinkParser.AgentRoute)DeepLinkParser.Parse(url)!;
        result.Link.TimeoutSeconds.Should().Be(30);
    }

    [Fact]
    public void Parse_AgentNegativeTimeoutSeconds_TreatedAsNull()
    {
        // Negative timeout is meaningless — parser must ignore it.
        var url    = new Uri("openclaw://agent?message=hi&timeoutSeconds=-5");
        var result = (DeepLinkParser.AgentRoute)DeepLinkParser.Parse(url)!;
        result.Link.TimeoutSeconds.Should().BeNull(
            because: "negative timeout values are invalid and must be ignored");
    }

    [Fact]
    public void Parse_AgentZeroTimeoutSeconds_Accepted()
    {
        // Zero means "no timeout" — valid.
        var url    = new Uri("openclaw://agent?message=hi&timeoutSeconds=0");
        var result = (DeepLinkParser.AgentRoute)DeepLinkParser.Parse(url)!;
        result.Link.TimeoutSeconds.Should().Be(0);
    }

    [Fact]
    public void Parse_AgentOptionalFields_PopulatedWhenPresent()
    {
        var url    = new Uri("openclaw://agent?message=hi&sessionKey=s1&to=bot&channel=general&thinking=extended");
        var result = (DeepLinkParser.AgentRoute)DeepLinkParser.Parse(url)!;
        var link   = result.Link;
        link.SessionKey.Should().Be("s1");
        link.To.Should().Be("bot");
        link.Channel.Should().Be("general");
        link.Thinking.Should().Be("extended");
    }

    // ── openclaw://gateway ─────────────────────────────────────────────────────

    [Fact]
    public void Parse_GatewayWithTls_ReturnsGatewayRoute()
    {
        var url    = new Uri("openclaw://gateway?host=myserver.example.com&port=18789&tls=true");
        var result = DeepLinkParser.Parse(url);

        result.Should().BeOfType<DeepLinkParser.GatewayRoute>();
        var route = (DeepLinkParser.GatewayRoute)result!;
        route.Link.Host.Should().Be("myserver.example.com");
        route.Link.Port.Should().Be(18789);
        route.Link.Tls.Should().BeTrue();
    }

    [Fact]
    public void Parse_GatewayMissingHost_ReturnsNull()
    {
        // A gateway URL without a host is unusable — reject.
        DeepLinkParser.Parse(new Uri("openclaw://gateway?port=18789&tls=true"))
            .Should().BeNull("host parameter is required for gateway deep links");
    }

    [Fact]
    public void Parse_GatewayNonTlsLoopback_IsAllowed()
    {
        // Non-TLS connections are permitted to loopback addresses (local dev).
        var url    = new Uri("openclaw://gateway?host=localhost&port=18789&tls=false");
        var result = DeepLinkParser.Parse(url);
        result.Should().BeOfType<DeepLinkParser.GatewayRoute>(
            because: "non-TLS to localhost is a safe local-only connection");
    }

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("::1")]
    public void Parse_GatewayNonTlsOtherLoopback_IsAllowed(string host)
    {
        var url    = new Uri($"openclaw://gateway?host={host}&port=18789&tls=false");
        var result = DeepLinkParser.Parse(url);
        result.Should().NotBeNull(
            because: $"{host} is a loopback address — non-TLS is safe");
    }

    [Fact]
    public void Parse_GatewayNonTlsMdnsHost_IsRejected()
    {
        // .local mDNS hosts are not loopback: ws:// would expose credentials on the LAN.
        // The deep link must be rejected here so the user is never put in a broken state
        // (GatewayUriNormalizer rejects ws:// to non-loopback hosts downstream anyway).
        var url    = new Uri("openclaw://gateway?host=mymachine.local&port=18789&tls=false");
        var result = DeepLinkParser.Parse(url);
        result.Should().BeNull(
            because: "mDNS .local hosts are not loopback — non-TLS would expose credentials on the LAN");
    }

    [Theory]
    [InlineData("192.168.1.100")]
    [InlineData("evil.com")]
    [InlineData("10.0.0.1")]
    [InlineData("myserver.example.com")]
    public void Parse_GatewayNonTlsRemoteHost_IsRejected(string host)
    {
        // Non-TLS to a non-loopback host is a critical security boundary:
        // it would transmit credentials and messages in plain text over the network.
        var url    = new Uri($"openclaw://gateway?host={host}&tls=false");
        var result = DeepLinkParser.Parse(url);
        result.Should().BeNull(
            because: $"non-TLS to non-loopback host {host} must be rejected to prevent credential interception");
    }

    [Fact]
    public void Parse_GatewayDefaultPort_Is18789()
    {
        var url    = new Uri("openclaw://gateway?host=myserver.example.com&tls=true");
        var result = (DeepLinkParser.GatewayRoute)DeepLinkParser.Parse(url)!;
        result.Link.Port.Should().Be(18789);
    }

    // ── GatewayConnectDeepLink.FromSetupCode ───────────────────────────────────

    [Fact]
    public void FromSetupCode_ValidWssCode_ParsesCorrectly()
    {
        // A valid setup code is a base64url-encoded JSON: {"url":"wss://...","token":"..."}
        var json = """{"url":"wss://host.example.com:18789","token":"abc123"}""";
        var code = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

        var result = GatewayConnectDeepLink.FromSetupCode(code);

        result.Should().NotBeNull();
        result!.Host.Should().Be("host.example.com");
        result.Port.Should().Be(18789);
        result.Tls.Should().BeTrue();
        result.Token.Should().Be("abc123");
    }

    [Fact]
    public void FromSetupCode_WsLoopbackCode_IsAllowed()
    {
        var json = """{"url":"ws://localhost:18789"}""";
        var code = Base64UrlEncode(json);
        var result = GatewayConnectDeepLink.FromSetupCode(code);
        result.Should().NotBeNull(
            because: "ws:// to localhost is a safe local-only setup code");
    }

    [Fact]
    public void FromSetupCode_WsRemoteHost_IsRejected()
    {
        // Plain-text WebSocket to a remote host must be rejected —
        // same security boundary as the parser enforces.
        var json = """{"url":"ws://evil.com:18789"}""";
        var code = Base64UrlEncode(json);
        GatewayConnectDeepLink.FromSetupCode(code)
            .Should().BeNull("ws:// to non-loopback host must be rejected");
    }

    [Fact]
    public void FromSetupCode_HttpScheme_IsRejected()
    {
        // Only ws:// and wss:// are valid — http:// must not create a gateway link.
        var json = """{"url":"http://myserver:18789"}""";
        var code = Base64UrlEncode(json);
        GatewayConnectDeepLink.FromSetupCode(code)
            .Should().BeNull("http:// setup code must be rejected — only ws/wss allowed");
    }

    [Fact]
    public void FromSetupCode_MissingUrl_ReturnsNull()
    {
        var json = """{"token":"abc"}""";
        var code = Base64UrlEncode(json);
        GatewayConnectDeepLink.FromSetupCode(code).Should().BeNull();
    }

    [Fact]
    public void FromSetupCode_GarbageInput_ReturnsNull()
    {
        GatewayConnectDeepLink.FromSetupCode("not-valid-base64!!!")
            .Should().BeNull("invalid base64 must return null without throwing");
    }

    [Fact]
    public void FromSetupCode_InvalidJson_ReturnsNull()
    {
        var code = Base64UrlEncode("{not json}");
        GatewayConnectDeepLink.FromSetupCode(code)
            .Should().BeNull("malformed JSON must be handled gracefully");
    }

    [Fact]
    public void FromSetupCode_EmptyInput_ReturnsNull()
    {
        GatewayConnectDeepLink.FromSetupCode(string.Empty).Should().BeNull();
    }

    // ── GatewayConnectDeepLink.IsLoopbackHost ─────────────────────────────────

    [Theory]
    [InlineData("localhost")]
    [InlineData("127.0.0.1")]
    [InlineData("::1")]
    public void IsLoopbackHost_LoopbackAddresses_ReturnsTrue(string host)
    {
        GatewayConnectDeepLink.IsLoopbackHost(host).Should().BeTrue();
    }

    [Theory]
    [InlineData("evil.com")]
    [InlineData("192.168.1.1")]
    [InlineData("10.0.0.1")]
    [InlineData("myserver.example.com")]
    [InlineData("notlocal")]
    [InlineData("mymachine.local")]   // mDNS — local network, not loopback
    [InlineData("MACHINE.LOCAL")]
    public void IsLoopbackHost_RemoteAddresses_ReturnsFalse(string host)
    {
        GatewayConnectDeepLink.IsLoopbackHost(host).Should().BeFalse();
    }

    // ── GatewayConnectDeepLink.WebSocketUri ───────────────────────────────────

    [Fact]
    public void WebSocketUri_TlsTrue_UsesWss()
    {
        var link = new GatewayConnectDeepLink("myserver.example.com", 18789, Tls: true, null, null);
        link.WebSocketUri!.Scheme.Should().Be("wss");
    }

    [Fact]
    public void WebSocketUri_TlsFalse_UsesWs()
    {
        var link = new GatewayConnectDeepLink("localhost", 18789, Tls: false, null, null);
        link.WebSocketUri!.Scheme.Should().Be("ws");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string Base64UrlEncode(string json)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(json);
        return Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }
}
