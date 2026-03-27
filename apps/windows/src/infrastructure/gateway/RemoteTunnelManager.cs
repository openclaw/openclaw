using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Manages the SSH tunnel lifecycle with backoff between restarts.
/// the restart-in-flight guard and 2-second backoff between reconnect attempts.
/// </summary>
internal sealed class RemoteTunnelManager : IDisposable
{
    // Tunables
    private static readonly TimeSpan RestartBackoff = TimeSpan.FromSeconds(2.0);

    private readonly ILogger<RemoteTunnelManager> _logger;
    private readonly IRemoteTunnelService _tunnel;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private bool _restartInFlight;
    private DateTimeOffset? _lastRestartAt;
    private int _lastLocalPort;
    private string? _lastTunnelEndpoint;
    private int _lastRemotePort;

    public RemoteTunnelManager(ILogger<RemoteTunnelManager> logger, IRemoteTunnelService tunnel)
    {
        _logger = logger;
        _tunnel = tunnel;
    }

    /// <summary>
    /// Ensures an SSH tunnel is running for the given endpoint and port.
    /// Returns the active local port, or an error if the tunnel could not be established.
    /// </summary>
    public async Task<ErrorOr<int>> EnsureControlTunnelAsync(
        string tunnelEndpoint, int desiredPort, int remotePort, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        bool alreadyRunning;
        try
        {
            // Reuse only when endpoint and remote port still match — config changes must reconnect.
            alreadyRunning = _tunnel.IsConnected && !_restartInFlight
                && _lastTunnelEndpoint == tunnelEndpoint
                && _lastRemotePort     == remotePort;
            if (alreadyRunning)
                _logger.LogInformation(
                    "reusing active SSH tunnel localPort={Port}", _lastLocalPort);
        }
        finally { _gate.Release(); }

        if (alreadyRunning)
            return _lastLocalPort > 0 ? _lastLocalPort : desiredPort;

        await WaitForRestartBackoffIfNeededAsync(ct).ConfigureAwait(false);

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try { BeginRestart(); }
        finally { _gate.Release(); }

        _logger.LogInformation(
            "ensure SSH tunnel endpoint={Ep} localPort={Port}", tunnelEndpoint, desiredPort);

        var result = await _tunnel.ConnectAsync(tunnelEndpoint, desiredPort, remotePort, ct).ConfigureAwait(false);

        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            EndRestart();
            if (!result.IsError)
            {
                _lastLocalPort       = desiredPort;
                _lastTunnelEndpoint  = tunnelEndpoint;
                _lastRemotePort      = remotePort;
                _logger.LogInformation("ssh tunnel ready localPort={Port}", desiredPort);
            }
        }
        finally { _gate.Release(); }

        return result.IsError ? result.Errors : desiredPort;
    }

    public async Task StopAllAsync(CancellationToken ct = default)
    {
        await _tunnel.DisconnectAsync(ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _lastLocalPort      = 0;
            _lastTunnelEndpoint = null;
        }
        finally { _gate.Release(); }
    }

    // schedules endRestart() after the backoff window via a fire-and-forget task.
    private void BeginRestart()
    {
        if (_restartInFlight) return;
        _restartInFlight = true;
        _lastRestartAt   = DateTimeOffset.UtcNow;
        _logger.LogInformation("control tunnel restart started");

        _ = Task.Run(async () =>
        {
            await Task.Delay(RestartBackoff).ConfigureAwait(false);
            await _gate.WaitAsync().ConfigureAwait(false);
            try { EndRestart(); }
            finally { _gate.Release(); }
        });
    }

    private void EndRestart()
    {
        if (_restartInFlight)
        {
            _restartInFlight = false;
            _logger.LogInformation("control tunnel restart finished");
        }
    }

    private async Task WaitForRestartBackoffIfNeededAsync(CancellationToken ct)
    {
        DateTimeOffset? last;
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try { last = _lastRestartAt; }
        finally { _gate.Release(); }

        if (last is null) return;

        var elapsed   = DateTimeOffset.UtcNow - last.Value;
        var remaining = RestartBackoff - elapsed;
        if (remaining <= TimeSpan.Zero) return;

        _logger.LogInformation(
            "control tunnel restart backoff {Seconds:F2}s", remaining.TotalSeconds);
        await Task.Delay(remaining, ct).ConfigureAwait(false);
    }

    public void Dispose() => _gate.Dispose();
}
