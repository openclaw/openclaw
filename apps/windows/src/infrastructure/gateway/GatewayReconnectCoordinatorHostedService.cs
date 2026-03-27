using MediatR;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Drives initial gateway connection and exponential-backoff reconnect on disconnect.
/// </summary>
internal sealed class GatewayReconnectCoordinatorHostedService : IHostedService
{
    // Tunables
    private const int BaseDelayMs  = 2_000;
    private const int MaxDelayMs   = 60_000;
    private const double JitterRatio = 0.30;

    // 1-second poll matches macOS observation cadence without burning CPU
    private const int PollIntervalMs = 1_000;

    private readonly ISettingsRepository _settings;
    private readonly IMediator _mediator;
    private readonly GatewayConnection _connection;
    private readonly IRemoteTunnelService _tunnel;
    private readonly ILogger<GatewayReconnectCoordinatorHostedService> _logger;

    private Task? _monitorTask;
    private CancellationTokenSource? _cts;

    public GatewayReconnectCoordinatorHostedService(
        ISettingsRepository settings,
        IMediator mediator,
        GatewayConnection connection,
        IRemoteTunnelService tunnel,
        ILogger<GatewayReconnectCoordinatorHostedService> logger)
    {
        _settings   = settings;
        _mediator   = mediator;
        _connection = connection;
        _tunnel     = tunnel;
        _logger     = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        // Task.Run so the monitor loop does not block host startup
        _monitorTask = Task.Run(() => MonitorAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _cts?.Cancel();
        if (_monitorTask is not null)
        {
            try { await _monitorTask.WaitAsync(ct); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _logger.LogWarning(ex, "Reconnect coordinator did not stop cleanly"); }
        }
    }

    // ── Monitor loop ──────────────────────────────────────────────────────────

    private async Task MonitorAsync(CancellationToken ct)
    {
        var attempt = 0;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(PollIntervalMs, ct).ConfigureAwait(false);

                var state = _connection.State;

                if (state == GatewayConnectionState.Connected)
                {
                    // Successful connection: reset backoff counter
                    attempt = 0;
                    continue;
                }

                // Skip while an attempt is already in flight or node is intentionally paused
                if (state is GatewayConnectionState.Connecting
                          or GatewayConnectionState.Reconnecting
                          or GatewayConnectionState.Paused)
                    continue;

                // State is Disconnected — check if we have a configured endpoint
                var endpoint = await ResolveEndpointAsync(ct);
                if (endpoint is null)
                {
                    // No endpoint → nothing to connect to, reset counter
                    attempt = 0;
                    continue;
                }

                var delayMs = ComputeBackoffMs(attempt);
                _logger.LogInformation(
                    "Gateway disconnected — reconnect attempt {Attempt} in {DelayMs}ms",
                    attempt + 1, delayMs);

                await Task.Delay(delayMs, ct).ConfigureAwait(false);

                // Re-check after the backoff wait — another path may have connected
                if (_connection.State != GatewayConnectionState.Disconnected)
                {
                    attempt = 0;
                    continue;
                }

                // First attempt goes straight to Connect; subsequent attempts go through
                // ReconnectGatewayCommand so MarkReconnecting() updates the state machine.
                var result = attempt == 0
                    ? await _mediator.Send(new ConnectToGatewayCommand(endpoint), ct)
                    : await _mediator.Send(new ReconnectGatewayCommand(endpoint), ct);

                if (result.IsError)
                    _logger.LogWarning("Connect attempt {Attempt} failed: {Error}",
                        attempt + 1, result.FirstError.Description);

                attempt++;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Reconnect coordinator error on attempt {Attempt}", attempt + 1);
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async Task<GatewayEndpoint?> ResolveEndpointAsync(CancellationToken ct)
    {
        var settings = await _settings.LoadAsync(ct);

        // Honour persisted pause across restarts — in-memory state starts as Disconnected.
        if (settings.IsPaused) return null;

        // Effective mode precedence:
        var mode = settings.ConnectionMode != ConnectionMode.Unconfigured
            ? settings.ConnectionMode
            : !string.IsNullOrWhiteSpace(settings.RemoteUrl) ? ConnectionMode.Remote
            : settings.OnboardingSeen ? ConnectionMode.Local
            : ConnectionMode.Unconfigured;

        if (mode == ConnectionMode.Unconfigured) return null;

        // Determine raw URI based on transport
        // Remote+Ssh: SSH tunnel forwards to local port 18789.
        // Remote+Direct or Local: use the configured GatewayEndpointUri or RemoteUrl.
        if (mode == ConnectionMode.Remote && settings.RemoteTransport == RemoteTransport.Ssh
            && !_tunnel.IsConnected)
        {
            // OQ-003: tunnel died after the initial apply — re-establish before reconnecting.
            _logger.LogInformation("SSH tunnel not alive — re-establishing");
            await _mediator.Send(new ApplyConnectionModeCommand(settings), ct);
            if (!_tunnel.IsConnected)
            {
                _logger.LogWarning("SSH tunnel re-establish failed — deferring reconnect");
                return null;
            }
        }

        string? rawUri = mode == ConnectionMode.Remote && settings.RemoteTransport == RemoteTransport.Ssh
            ? ResolveSshLocalUri(settings)
            : mode == ConnectionMode.Remote && !string.IsNullOrWhiteSpace(settings.RemoteUrl)
                ? settings.RemoteUrl
                : settings.GatewayEndpointUri;

        // Normalize URI — adds default port 18789 for ws://, enforces loopback for ws://
        var normalized = GatewayUriNormalizer.Normalize(rawUri);
        if (normalized is null) return null;

        var result = GatewayEndpoint.Create(normalized, "gateway");
        return result.IsError ? null : result.Value;
    }

    // The SSH tunnel is a transparent TCP forward, so TLS (for wss://) is end-to-end
    // between the client and the remote gateway — the local tunnel port carries whatever
    // protocol the remote expects. Preserve the scheme from settings.RemoteUrl so wss://
    // remotes receive a TLS ClientHello through the tunnel rather than plaintext WS.
    private static string ResolveSshLocalUri(AppSettings settings)
    {
        var raw = settings.RemoteUrl?.Trim();
        if (!string.IsNullOrEmpty(raw) && Uri.TryCreate(raw, UriKind.Absolute, out var url))
        {
            var scheme = url.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws";
            return $"{scheme}://localhost:18789";
        }
        return "ws://localhost:18789";
    }

    private static int ComputeBackoffMs(int attempt)
    {
        // Exponential: 2s → 4s → 8s → 16s → 32s → 60s (capped)
        // Use long to avoid int overflow when attempt is large (unbounded counter).
        var expo   = (int)Math.Min((long)BaseDelayMs * (1L << Math.Min(attempt, 30)), (long)MaxDelayMs);
        var jitter = (Random.Shared.NextDouble() * 2.0 - 1.0) * JitterRatio * expo;
        // Floor at 500ms so a large negative jitter never produces an instant retry
        return Math.Max(500, (int)(expo + jitter));
    }
}
