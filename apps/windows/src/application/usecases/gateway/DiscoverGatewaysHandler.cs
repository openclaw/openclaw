using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-005")]
public sealed record DiscoverGatewaysQuery : IRequest<ErrorOr<IReadOnlyList<GatewayEndpoint>>>;

internal sealed class DiscoverGatewaysHandler
    : IRequestHandler<DiscoverGatewaysQuery, ErrorOr<IReadOnlyList<GatewayEndpoint>>>
{
    private readonly IEnumerable<IGatewayDiscovery> _sources;
    private readonly ILogger<DiscoverGatewaysHandler> _logger;

    public DiscoverGatewaysHandler(
        IEnumerable<IGatewayDiscovery> sources,
        ILogger<DiscoverGatewaysHandler> logger)
    {
        _sources = sources;
        _logger = logger;
    }

    public async Task<ErrorOr<IReadOnlyList<GatewayEndpoint>>> Handle(
        DiscoverGatewaysQuery _, CancellationToken ct)
    {
        var results = new List<GatewayEndpoint>();

        // Run all discovery sources concurrently and merge results
        var tasks = _sources
            .Select(s => CollectAsync(s, results, ct))
            .ToList();

        await Task.WhenAll(tasks);
        return results.AsReadOnly();
    }

    private async Task CollectAsync(
        IGatewayDiscovery source,
        List<GatewayEndpoint> results,
        CancellationToken ct)
    {
        await foreach (var endpoint in source.DiscoverAsync(ct))
        {
            lock (results)
                results.Add(endpoint);
            _logger.LogDebug("Discovered gateway {Name} at {Uri}", endpoint.DisplayName, endpoint.Uri);
        }
    }
}
