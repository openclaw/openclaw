using System.Runtime.CompilerServices;
using System.Threading.Channels;
using OpenClawWindows.Domain.Gateway;
using Zeroconf;

namespace OpenClawWindows.Infrastructure.Gateway;

// mDNS/DNS-SD gateway discovery
// Service type: _openclaw-gw._tcp.local.
// SPIKE-003 resolved: uses Zeroconf NuGet (pure .NET, ARM64-safe, .NET 9 compatible).
internal sealed class MdnsGatewayDiscoveryAdapter : IGatewayDiscovery
{
    private const string ServiceType = "_openclaw-gw._tcp.local.";

    private readonly ILogger<MdnsGatewayDiscoveryAdapter> _logger;

    public MdnsGatewayDiscoveryAdapter(ILogger<MdnsGatewayDiscoveryAdapter> logger)
    {
        _logger = logger;
    }

    public async IAsyncEnumerable<GatewayEndpoint> DiscoverAsync(
        [EnumeratorCancellation] CancellationToken ct)
    {
        // Channel bridges Zeroconf's callback-based BrowseAsync to IAsyncEnumerable.
        var channel = Channel.CreateUnbounded<GatewayEndpoint>(
            new UnboundedChannelOptions { SingleReader = true });

        var browseTask = BrowseAsync(channel.Writer, ct);

        // BrowseAsync always calls writer.Complete() in its finally block — use None here
        // so cancellation is handled by BrowseAsync rather than throwing from ReadAllAsync.
        await foreach (var endpoint in channel.Reader.ReadAllAsync(CancellationToken.None))
            yield return endpoint;

        await browseTask;
    }

    private async Task BrowseAsync(ChannelWriter<GatewayEndpoint> writer, CancellationToken ct)
    {
        try
        {
            await ZeroconfResolver.ResolveAsync(
                ServiceType,
                callback: host =>
                {
                    foreach (var (_, svc) in host.Services)
                    {
                        var endpoint = GatewayEndpoint.FromMdns(
                            host.IPAddress,
                            svc.Port,
                            host.DisplayName);

                        if (endpoint.IsError)
                        {
                            _logger.LogWarning(
                                "mDNS: skipping invalid endpoint {Host}:{Port} — {Error}",
                                host.IPAddress, svc.Port, endpoint.FirstError.Description);
                            return;
                        }

                        _logger.LogInformation(
                            "mDNS: discovered gateway {Name} at {Uri}",
                            host.DisplayName, endpoint.Value.Uri);

                        // TryWrite is sync; channel is unbounded so it won't block.
                        writer.TryWrite(endpoint.Value);
                    }
                },
                cancellationToken: ct);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown via cancellation.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "mDNS browse failed");
        }
        finally
        {
            writer.Complete();
        }
    }
}
