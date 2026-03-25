using MediatR;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Gateway;

/// <summary>
/// Orchestrates connection mode transitions: stops/starts the local gateway process,
/// tears down remote tunnels, and clears node error state.
/// </summary>
internal sealed class ConnectionModeCoordinator
{
    // Tunables
    private const int GatewayReadyTimeoutSeconds = 6;

    private readonly IGatewayProcessManager             _processManager;
    private readonly IRemoteTunnelService               _tunnelService;
    private readonly INodesStore                        _nodesStore;
    private readonly IGatewayEndpointStore              _endpointStore;
    private readonly IPortGuardian                      _portGuardian;
    private readonly IMediator                          _mediator;
    private readonly ILogger<ConnectionModeCoordinator> _logger;

    private ConnectionMode? _lastMode;
    private readonly object _modeLock = new();

    internal ConnectionModeCoordinator(
        IGatewayProcessManager             processManager,
        IRemoteTunnelService               tunnelService,
        INodesStore                        nodesStore,
        IGatewayEndpointStore              endpointStore,
        IPortGuardian                      portGuardian,
        IMediator                          mediator,
        ILogger<ConnectionModeCoordinator> logger)
    {
        _processManager = processManager;
        _tunnelService  = tunnelService;
        _nodesStore     = nodesStore;
        _endpointStore  = endpointStore;
        _portGuardian   = portGuardian;
        _mediator       = mediator;
        _logger         = logger;
    }

    internal async Task ApplyAsync(ConnectionMode mode, bool paused, CancellationToken ct = default)
    {
        bool modeChanged;
        lock (_modeLock)
        {
            modeChanged = _lastMode.HasValue && _lastMode.Value != mode;
            _lastMode   = mode;
        }

        if (modeChanged)
        {
            // No Windows equivalent in IGatewayProcessManager — process restart via SetActive resets state.
            _nodesStore.SetCancelled(null);
        }

        switch (mode)
        {
            case ConnectionMode.Unconfigured:
                _nodesStore.SetCancelled(null);
                await _tunnelService.DisconnectAsync(ct);
                _processManager.SetActive(false);
                await _mediator.Send(new DisconnectFromGatewayCommand("mode_unconfigured"), ct);
                _ = _portGuardian.SweepAsync(ConnectionMode.Unconfigured);
                break;

            case ConnectionMode.Local:
                _nodesStore.SetCancelled(null);
                await _tunnelService.DisconnectAsync(ct);

                if (GatewayAutostartPolicy.ShouldStartGateway(ConnectionMode.Local, paused))
                {
                    _processManager.SetActive(true);
                    // Autostart registration is handled via RegisterAutostartCommand at startup —
                    // no per-mode-change equivalent needed on Windows.
                    await _processManager.WaitForGatewayReadyAsync(
                        TimeSpan.FromSeconds(GatewayReadyTimeoutSeconds), ct);
                }
                else
                {
                    _processManager.SetActive(false);
                }
                _ = _portGuardian.SweepAsync(ConnectionMode.Local);
                break;

            case ConnectionMode.Remote:
                _processManager.SetActive(false);
                _nodesStore.SetCancelled(null);
                try
                {
                    await _endpointStore.EnsureRemoteControlTunnelAsync(ct);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "remote tunnel/configure failed");
                }
                _ = _portGuardian.SweepAsync(ConnectionMode.Remote);
                break;
        }
    }
}
