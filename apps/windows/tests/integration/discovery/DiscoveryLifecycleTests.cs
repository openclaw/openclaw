using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Integration.Discovery;

// Integration: mDNS and wide-area gateway discovery adapters.
// WideAreaGatewayDiscoveryAdapter is guarded by OPENCLAW_WIDE_AREA_DOMAIN;
// without that env var it yields nothing immediately.
// MdnsGatewayDiscoveryAdapter yields nothing when cancelled immediately.
public sealed class DiscoveryLifecycleTests
{
    // ── WideAreaGatewayDiscoveryAdapter ───────────────────────────────────────

    [Fact]
    public async Task WideAreaDiscovery_NoEnvVar_YieldsNothing()
    {
        // Ensure the env var is absent
        Environment.SetEnvironmentVariable("OPENCLAW_WIDE_AREA_DOMAIN", null);

        var adapter = new WideAreaGatewayDiscoveryAdapter(
            NullLogger<WideAreaGatewayDiscoveryAdapter>.Instance);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var endpoints = new List<GatewayEndpoint>();

        await foreach (var ep in adapter.DiscoverAsync(cts.Token))
            endpoints.Add(ep);

        // No domain → no DNS queries → no endpoints
        endpoints.Should().BeEmpty();
    }

    [Fact]
    public async Task WideAreaDiscovery_ImmediatelyCancelled_DoesNotThrow()
    {
        Environment.SetEnvironmentVariable("OPENCLAW_WIDE_AREA_DOMAIN", null);

        var adapter = new WideAreaGatewayDiscoveryAdapter(
            NullLogger<WideAreaGatewayDiscoveryAdapter>.Instance);

        using var cts = new CancellationTokenSource();
        cts.Cancel();

        var endpoints = new List<GatewayEndpoint>();

        var act = async () =>
        {
            await foreach (var ep in adapter.DiscoverAsync(cts.Token))
                endpoints.Add(ep);
        };

        await act.Should().NotThrowAsync();
    }

    // ── MdnsGatewayDiscoveryAdapter ──────────────────────────────────────────

    [Fact]
    public async Task MdnsDiscovery_ImmediatelyCancelled_YieldsNothingWithoutThrowing()
    {
        var adapter = new MdnsGatewayDiscoveryAdapter(
            NullLogger<MdnsGatewayDiscoveryAdapter>.Instance);

        using var cts = new CancellationTokenSource();
        cts.Cancel();

        var endpoints = new List<GatewayEndpoint>();

        var act = async () =>
        {
            await foreach (var ep in adapter.DiscoverAsync(cts.Token))
                endpoints.Add(ep);
        };

        await act.Should().NotThrowAsync();
        endpoints.Should().BeEmpty();
    }

    [Fact(Skip = "Environment-sensitive: fails when a real OpenClaw gateway is advertising via mDNS on the local network (e.g. the user's macOS node). Passes in CI.")]
    public async Task MdnsDiscovery_ShortTimeout_YieldsNothingOnEmptyNetwork()
    {
        var adapter = new MdnsGatewayDiscoveryAdapter(
            NullLogger<MdnsGatewayDiscoveryAdapter>.Instance);

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        var endpoints = new List<GatewayEndpoint>();

        try
        {
            await foreach (var ep in adapter.DiscoverAsync(cts.Token))
                endpoints.Add(ep);
        }
        catch (OperationCanceledException)
        {
            // Expected — the cancellation propagates from the channel
        }

        // In a test environment no _openclaw-gw._tcp.local. services are present
        endpoints.Should().BeEmpty();
    }

    // ── IGatewayDiscovery interface contract ─────────────────────────────────

    [Fact]
    public void WideAreaAdapter_ImplementsIGatewayDiscovery()
    {
        var adapter = new WideAreaGatewayDiscoveryAdapter(
            NullLogger<WideAreaGatewayDiscoveryAdapter>.Instance);

        adapter.Should().BeAssignableTo<IGatewayDiscovery>();
    }

    [Fact]
    public void MdnsAdapter_ImplementsIGatewayDiscovery()
    {
        var adapter = new MdnsGatewayDiscoveryAdapter(
            NullLogger<MdnsGatewayDiscoveryAdapter>.Instance);

        adapter.Should().BeAssignableTo<IGatewayDiscovery>();
    }
}
