using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Gateway;

// Iterates ReceiveMessagesAsync() and dispatches "res"/"event" frames to the RPC layer.
// connect.challenge → hello-ok handshake and the ongoing frame routing.
internal sealed class GatewayReceiveLoopHostedService : IHostedService
{
    // Tunables
    private const int RetryDelayMs = 500;  // pause between idle polls when not yet connected

    private readonly IGatewayWebSocket _ws;
    private readonly IGatewayMessageRouter _router;
    private readonly GatewayConnection _connection;
    private readonly IWorkActivityStore _workActivity;
    private readonly ISettingsRepository _settings;
    private readonly ISender _sender;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<GatewayReceiveLoopHostedService> _logger;

    private Task? _loopTask;
    private CancellationTokenSource? _cts;

    // Set when we send the connect req; cleared when the matching hello-ok res arrives.
    // Single-threaded within the loop so no lock needed.
    private string? _connectRequestId;

    public GatewayReceiveLoopHostedService(
        IGatewayWebSocket ws,
        IGatewayMessageRouter router,
        GatewayConnection connection,
        IWorkActivityStore workActivity,
        ISettingsRepository settings,
        ISender sender,
        TimeProvider timeProvider,
        ILogger<GatewayReceiveLoopHostedService> logger)
    {
        _ws = ws;
        _router = router;
        _connection = connection;
        _workActivity = workActivity;
        _settings = settings;
        _sender = sender;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        // Task.Run so the loop does not block the host startup sequence
        _loopTask = Task.Run(() => RunAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _cts?.Cancel();
        if (_loopTask is not null)
        {
            try { await _loopTask.WaitAsync(ct); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _logger.LogWarning(ex, "Receive loop did not stop cleanly"); }
        }
    }

    // ── Outer retry loop ───────────────────────────────────────────────────────

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await foreach (var json in _ws.ReceiveMessagesAsync(ct))
                {
                    try { await DispatchFrameAsync(json, ct); }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
                    catch (Exception ex) { _logger.LogWarning(ex, "Error dispatching gateway frame"); }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex) { _logger.LogWarning(ex, "Gateway receive loop error"); }

            // Socket closed or errored — reset the handshake gate so new RPCs
            // block until the next successful hello-ok after reconnect.
            _router.ResetHandshakeGate();

            // If the socket closed while a connect handshake was in progress (state = Connecting
            // or Reconnecting), mark disconnected so the coordinator can schedule a retry.
            // Without this, state stays Connecting and the coordinator skips indefinitely.
            if (_connection.State is GatewayConnectionState.Connecting
                                  or GatewayConnectionState.Reconnecting)
            {
                _connection.MarkDisconnected("socket_closed_during_handshake");
                _ = _sender.Send(
                    new UpdateTrayMenuStateCommand("disconnected", null, null, 0, null, false),
                    CancellationToken.None);
            }

            // ReceiveMessagesAsync returned without frames — not connected yet or disconnected.
            // GAP-016 drives reconnect; this loop just waits until the socket is open again.
            if (!ct.IsCancellationRequested)
                await Task.Delay(RetryDelayMs, ct).ConfigureAwait(false);
        }
    }

    // ── Frame dispatch ─────────────────────────────────────────────────────────

    private async Task DispatchFrameAsync(string json, CancellationToken ct)
    {
        JsonElement root;
        try
        {
            // Clone immediately so root owns its own memory, independent of the doc lifetime
            using var doc = JsonDocument.Parse(json);
            root = doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Malformed gateway frame");
            return;
        }

        if (!root.TryGetProperty("type", out var typeProp)) return;

        var frameType = typeProp.GetString();
        switch (frameType)
        {
            case "res":
                HandleResFrame(root);
                break;
            case "event":
                await HandleEventFrameAsync(root, ct);
                break;
            default:
                _logger.LogDebug("Gateway unknown frame type={Type}", frameType);
                break;
        }
    }

    // ── "res" frame ────────────────────────────────────────────────────────────

    private void HandleResFrame(JsonElement root)
    {
        if (!root.TryGetProperty("id", out var idProp)) return;
        var id = idProp.GetString();
        if (string.IsNullOrEmpty(id)) return;
        var ok = root.TryGetProperty("ok", out var okProp) && okProp.GetBoolean();

        // Clone payload/error so they outlive this call frame (stored in TCS or parsed)
        JsonElement? payload = root.TryGetProperty("payload", out var pl) ? pl.Clone() : null;
        JsonElement? error = root.TryGetProperty("error", out var err) ? err.Clone() : null;

        // Connect handshake response — not in the pending map; handle here
        if (id == _connectRequestId)
        {
            _connectRequestId = null;
            if (ok && payload.HasValue)
            {
                ApplyHelloOk(payload.Value);
            }
            else
            {
                _logger.LogWarning("Gateway connect response ok={Ok} error={Error}",
                    ok, error?.GetRawText() ?? "none");
                // Gateway rejected the connect — mark disconnected so the reconnect coordinator
                // can retry. Without this, state stays Connecting and the coordinator skips forever.
                _connection.MarkDisconnected("connect_rejected");
                _ = _sender.Send(
                    new UpdateTrayMenuStateCommand("disconnected", null, null, 0, null, false),
                    CancellationToken.None);
            }
            return;
        }

        _router.RouteResponse(id, ok, payload, error);
    }

    // ── "event" frame ──────────────────────────────────────────────────────────

    private async Task HandleEventFrameAsync(JsonElement root, CancellationToken ct)
    {
        if (!root.TryGetProperty("event", out var evtProp)) return;
        var eventName = evtProp.GetString() ?? string.Empty;
        JsonElement? payload = root.TryGetProperty("payload", out var pl) ? pl.Clone() : null;

        // connect.challenge is the first frame after TCP handshake — respond with connect req
        if (eventName == "connect.challenge")
        {
            await SendConnectRequestAsync(ct);
            return;
        }

        _router.RouteEvent(eventName, payload);
    }

    // ── Connect handshake ──────────────────────────────────────────────────────

    private async Task SendConnectRequestAsync(CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString();
        _connectRequestId = id;  // set before sending so the res handler can match it

        // Extract auth token: first try settings URI user-info (ws://token@host:port),
        // then fall back to ~/.openclaw/openclaw.json → gateway.auth.token.
        string? token = null;
        try
        {
            var s = await _settings.LoadAsync(ct).ConfigureAwait(false);
            var rawUri = s.GatewayEndpointUri;
            if (!string.IsNullOrWhiteSpace(rawUri) &&
                Uri.TryCreate(rawUri.Trim(), UriKind.Absolute, out var parsedUri) &&
                !string.IsNullOrEmpty(parsedUri.UserInfo))
            {
                token = Uri.UnescapeDataString(parsedUri.UserInfo.Split(':')[0]);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not read gateway token from settings");
        }

        // Fallback: read token from gateway config file (covers auto-resolved URIs
        // that don't embed the token in user-info).
        if (string.IsNullOrEmpty(token))
        {
            token = Domain.Config.OpenClawConfigFile.ReadGatewayAuthToken();
        }

        // Read password for deployments using gateway.auth.mode=password.
        string? password = null;
        if (string.IsNullOrEmpty(token))
        {
            password = Domain.Config.OpenClawConfigFile.GatewayPassword();
        }

        _logger.LogInformation("Sending connect: tokenPresent={HasToken} passwordPresent={HasPw}",
            !string.IsNullOrEmpty(token), !string.IsNullOrEmpty(password));

        object auth = !string.IsNullOrEmpty(token)
            ? new { token }
            : !string.IsNullOrEmpty(password)
                ? (object)new { password }
                : new { };

        var frame = JsonSerializer.Serialize(new
        {
            type = "req",
            id,
            method = "connect",
            @params = new
            {
                minProtocol = 3,
                maxProtocol = 3,
                client = new
                {
                    // Gateway v2026.3.13 clears all scopes for non-controlUi clients without
                    // device identity (clearUnboundScopes in message-handler).  Using
                    // "openclaw-control-ui" makes isControlUi=true, which preserves scopes
                    // when the auth decision is "allow" (sharedAuthOk=true via token match).
                    id = "openclaw-control-ui",
                    version = "1.0.0",
                    platform = "windows",
                    mode = "ui",
                    displayName = "OpenClaw Windows"
                },
                role = "operator",
                scopes = new[] { "operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing" },
                caps = Array.Empty<string>(),
                commands = Array.Empty<string>(),
                permissions = new { },
                auth,
                locale = "en-US",
                userAgent = "openclaw-windows/1.0.0"
            },
        });

        // Diagnostic: dump the full connect frame so we can verify auth/scopes on the wire
        _logger.LogInformation("Connect frame (first 500 chars): {Frame}", frame.Length > 500 ? frame[..500] : frame);

        var result = await _ws.SendAsync(frame, ct);
        if (result.IsError)
        {
            _logger.LogWarning("Failed to send connect request: {Error}", result.FirstError.Description);
            _connectRequestId = null;
        }
    }

    private void ApplyHelloOk(JsonElement payload)
    {
        _logger.LogInformation("hello-ok raw payload: {Payload}", payload.GetRawText());

        // Extract mainSessionKey from snapshot.sessiondefaults
        var sessionKey = "main";
        if (payload.TryGetProperty("snapshot", out var snapshot) &&
            snapshot.TryGetProperty("sessiondefaults", out var defaults) &&
            defaults.TryGetProperty("mainSessionKey", out var mkProp))
        {
            var mk = mkProp.GetString()?.Trim();
            if (!string.IsNullOrEmpty(mk)) sessionKey = mk;
        }

        string? canvasHostUrl = null;
        if (payload.TryGetProperty("canvasHostUrl", out var canvasProp))
        {
            var raw = canvasProp.GetString()?.Trim();
            if (!string.IsNullOrEmpty(raw)) canvasHostUrl = raw;
        }

        try
        {
            _connection.MarkConnected(sessionKey, canvasHostUrl, _timeProvider);
            // Sync the main session key so WorkActivityStore can classify jobs correctly.
            _workActivity.SetMainSessionKey(sessionKey);
            _logger.LogInformation("Gateway connected sessionKey={Key}", sessionKey);

            // Unblock pending RPCs that were waiting for the handshake to complete.
            _router.NotifyHandshakeComplete();

            // Auto-resolve Unconfigured → Local when gateway is confirmed reachable.
            // Skipping onboarding shouldn't leave the tray stuck on "Not Configured".
            _ = Task.Run(async () =>
            {
                try
                {
                    var s = await _settings.LoadAsync(CancellationToken.None);
                    if (s.ConnectionMode == ConnectionMode.Unconfigured)
                    {
                        s.SetConnectionMode(ConnectionMode.Local);
                        s.SetOnboardingSeen(true);
                        await _settings.SaveAsync(s, CancellationToken.None);
                        _logger.LogInformation("Auto-resolved ConnectionMode to Local after hello-ok");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to auto-resolve ConnectionMode");
                }
            });

            // Notify the tray — fire-and-forget, best effort.
            _ = _sender.Send(new UpdateTrayMenuStateCommand("connected", sessionKey, null, 0, null, false))
                .ContinueWith(t =>
                {
                    if (t.IsFaulted)
                        _logger.LogWarning(t.Exception, "UpdateTrayMenuState fire-and-forget failed");
                    else
                        _logger.LogInformation("Tray notified: connected");
                }, TaskScheduler.Default);
        }
        catch (Exception ex)
        {
            // MarkConnected throws if the state machine is not in Connecting.
            // GAP-016 drives MarkConnecting() before each connect attempt;
            // this guard prevents a crash if the sequence is out of order.
            _logger.LogWarning(ex, "MarkConnected failed — state machine not in Connecting");
        }
    }
}
