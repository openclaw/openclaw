using MediatR;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Subscribes to IGatewayEndpointStore and triggers reconnect whenever the resolved URL changes.
/// Also kicks a PortGuardian port sweep at startup.
/// </summary>
internal sealed class GatewayConnectivityCoordinator : IHostedService
{
    private readonly IGatewayEndpointStore _endpointStore;
    private readonly IMediator             _mediator;
    private readonly IPortGuardian         _portGuardian;
    private readonly ILogger<GatewayConnectivityCoordinator> _logger;

    private string? _lastResolvedUri;

    // Observable state
    public ConnectionMode? ResolvedMode      { get; private set; }
    public string?         ResolvedHostLabel { get; private set; }

    public GatewayConnectivityCoordinator(
        IGatewayEndpointStore endpointStore,
        IMediator             mediator,
        IPortGuardian         portGuardian,
        ILogger<GatewayConnectivityCoordinator> logger)
    {
        _endpointStore = endpointStore;
        _mediator      = mediator;
        _portGuardian  = portGuardian;
        _logger        = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        // Subscribe before reading CurrentState to avoid missing a state change in the gap.
        _endpointStore.StateChanged += OnEndpointStateChanged;

        // Process the initial state
        HandleEndpointState(_endpointStore.CurrentState);

        // Kick a port sweep at startup.
        var initialMode = ResolvedMode ?? ConnectionMode.Unconfigured;
        _ = _portGuardian.SweepAsync(initialMode);

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        _endpointStore.StateChanged -= OnEndpointStateChanged;
        return Task.CompletedTask;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void OnEndpointStateChanged(object? sender, GatewayEndpointState state)
        => HandleEndpointState(state);

    private void HandleEndpointState(GatewayEndpointState state)
    {
        switch (state)
        {
            case GatewayEndpointState.Ready r:
            {
                ResolvedMode      = r.Mode;
                ResolvedHostLabel = HostLabel(r.Url);
                var uri        = r.Url.AbsoluteUri;
                var urlChanged = _lastResolvedUri is not null && _lastResolvedUri != uri;
                if (urlChanged)
                {
                    _logger.LogInformation(
                        "Gateway endpoint changed from {Old} to {New} — refreshing",
                        _lastResolvedUri, uri);
                    _ = _mediator.Send(new DisconnectFromGatewayCommand("endpoint_changed"));
                }
                _lastResolvedUri = uri;
                break;
            }

            case GatewayEndpointState.Connecting c:
                ResolvedMode = c.Mode;
                break;

            case GatewayEndpointState.Unavailable u:
                ResolvedMode = u.Mode;
                break;
        }
    }

    private static string HostLabel(Uri uri)
    {
        var host = uri.Host;
        return uri.IsDefaultPort ? host : $"{host}:{uri.Port}";
    }
}
