namespace OpenClawWindows.Tests.Unit.Domain.Gateway;

public sealed class GatewayEndpointTests
{
    [Theory]
    [InlineData("ws://localhost:3000")]
    [InlineData("wss://gateway.example.com:8443")]
    public void Create_ValidWsUri_Succeeds(string uri)
    {
        var result = GatewayEndpoint.Create(uri, "Local Gateway");

        result.IsError.Should().BeFalse();
        result.Value.Uri.ToString().Should().Contain(uri.Split('/')[2]); // host present
    }

    [Theory]
    [InlineData("http://localhost:3000")]  // wrong scheme
    [InlineData("not-a-uri")]             // invalid uri
    [InlineData("ftp://host")]             // wrong scheme
    public void Create_InvalidUri_ReturnsError(string uri)
    {
        var result = GatewayEndpoint.Create(uri, "name");

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void Create_EmptyUri_ReturnsError()
    {
        var act = () => GatewayEndpoint.Create("", "name");
        act.Should().Throw<Exception>();
    }

    [Fact]
    public void FromMdns_BuildsWsUri()
    {
        var result = GatewayEndpoint.FromMdns("gateway.local", 3000, "OpenClaw Gateway");

        result.IsError.Should().BeFalse();
        result.Value.Uri.Host.Should().Be("gateway.local");
        result.Value.Uri.Port.Should().Be(3000);
        result.Value.Uri.Scheme.Should().Be("ws");
    }
}
