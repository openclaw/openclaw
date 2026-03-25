using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// mDNS-based gateway discovery on the local network.
/// </summary>
public interface IGatewayDiscovery
{
    IAsyncEnumerable<GatewayEndpoint> DiscoverAsync(CancellationToken ct);
}
