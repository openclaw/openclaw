using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Resolves and publishes the effective gateway control endpoint.
/// remote tunnel orchestration, and state subscribers.
/// </summary>
public interface IGatewayEndpointStore
{
    GatewayEndpointState CurrentState { get; }

    event EventHandler<GatewayEndpointState>? StateChanged;

    Task RefreshAsync(CancellationToken ct = default);

    Task SetModeAsync(ConnectionMode mode, CancellationToken ct = default);

    /// <summary>
    /// Returns a ready config, establishing the remote tunnel if needed.
    /// Throws if the endpoint cannot be resolved. Mirrors requireConfig().
    /// </summary>
    Task<GatewayEndpointConfig> RequireConfigAsync(CancellationToken ct = default);

    /// <summary>
    /// Ensures the remote control tunnel is running and returns the forwarded port.
    /// </summary>
    Task<ushort> EnsureRemoteControlTunnelAsync(CancellationToken ct = default);

    /// <summary>
    /// If bind mode is tailnet and the current URL is loopback, re-resolves to the
    /// Tailscale IP and publishes a new Ready state. Mirrors maybeFallbackToTailnet(from:).
    /// </summary>
    Task<GatewayEndpointConfig?> MaybeFallbackToTailnetAsync(Uri currentUrl, CancellationToken ct = default);
}
