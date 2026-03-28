using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using MediatR;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.NodeMode;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Pairing;
using OpenClawWindows.Domain.Permissions;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Infrastructure.NodeMode;

/// <summary>
/// Manages the dedicated "node" WebSocket session — a second, independent connection
/// to the same gateway with role:"node".
/// Owns TLS TOFU pinning, exponential backoff, node.invoke dispatch, and push event sending.
/// Separate from the control-channel WS to allow independent reconnect lifecycles.
/// </summary>
internal sealed class WindowsNodeModeCoordinator : IHostedService, INodeEventSink
{
    // Tunables
    private const long InitialRetryDelayMs = 1_000;   // 1 s base
    private const long MaxRetryDelayMs     = 10_000;  // 10 s cap
    private const int  CapsPollMs          = 200;      // poll interval when paused or no endpoint

    private readonly ISettingsRepository                     _settings;
    private readonly IPermissionManager                      _permissions;
    private readonly GatewayTlsPinStore                      _pinStore;
    private readonly IKeypairStorage                         _keypairStorage;
    private readonly IGatewayEndpointStore                   _endpointStore;
    private readonly IMediator                               _mediator;
    private readonly IGatewayRpcChannel                      _rpc;
    private readonly INodeRuntimeContext                     _nodeRuntime;
    private readonly ILogger<WindowsNodeModeCoordinator>     _logger;

    private Task?                    _runTask;
    private CancellationTokenSource? _cts;

    // Held for the lifetime of an active node session; cleared to null between sessions.
    // Volatile so TrySendEvent sees the latest value without a lock.
    private volatile ClientWebSocket? _activeNodeWs;

    // Serializes all sends on the active node WS — WebSocket.SendAsync is not thread-safe.
    private readonly SemaphoreSlim _wsSendLock = new SemaphoreSlim(1, 1);

    public WindowsNodeModeCoordinator(
        ISettingsRepository                 settings,
        IPermissionManager                  permissions,
        GatewayTlsPinStore                  pinStore,
        IKeypairStorage                     keypairStorage,
        IGatewayEndpointStore               endpointStore,
        IMediator                           mediator,
        IGatewayRpcChannel                  rpc,
        INodeRuntimeContext                 nodeRuntime,
        ILogger<WindowsNodeModeCoordinator> logger)
    {
        _settings       = settings;
        _permissions    = permissions;
        _pinStore       = pinStore;
        _keypairStorage = keypairStorage;
        _endpointStore  = endpointStore;
        _mediator       = mediator;
        _rpc            = rpc;
        _nodeRuntime    = nodeRuntime;
        _logger         = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _cts     = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _runTask = Task.Run(() => RunAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _cts?.Cancel();
        if (_runTask is not null)
        {
            try { await _runTask.WaitAsync(ct); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _logger.LogWarning(ex, "Node coordinator did not stop cleanly"); }
        }
    }

    // ── Outer retry loop ───────────────────────────────────────────────────────

    private async Task RunAsync(CancellationToken ct)
    {
        _logger.LogInformation("NODE-COORD: RunAsync STARTED — node coordinator is alive");
        long  retryDelayMs       = InitialRetryDelayMs;
        bool? lastCameraEnabled  = null;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var settings = await _settings.LoadAsync(ct);

                if (settings.IsPaused)
                {
                    await Task.Delay(CapsPollMs, ct);
                    continue;
                }

                var cameraEnabled = await IsCameraEnabledAsync(ct);

                // Disconnect and reconnect when camera permission changes so caps stay accurate
                if (lastCameraEnabled.HasValue && lastCameraEnabled != cameraEnabled)
                {
                    lastCameraEnabled = cameraEnabled;
                    await Task.Delay(CapsPollMs, ct);
                    continue;
                }
                lastCameraEnabled = cameraEnabled;

                var resolvedUri = ResolveEndpointUri(settings);
                if (resolvedUri is null)
                {
                    _logger.LogDebug("NODE-COORD: no endpoint resolved, mode={Mode}", settings.ConnectionMode);
                    await Task.Delay(CapsPollMs, ct);
                    continue;
                }
                _logger.LogInformation("NODE-COORD: connecting to {Uri}", resolvedUri);

                var locationEnabled = await IsLocationEnabledAsync(ct);
                var browserEnabled  = Domain.Config.OpenClawConfigFile.BrowserControlEnabled();
                var caps            = BuildCaps(cameraEnabled, locationEnabled, browserEnabled);
                var commands        = BuildCommands(caps);
                var permissions     = await BuildPermissionsAsync(ct);

                await RunNodeSessionAsync(resolvedUri, caps, commands, permissions, ct);

                // Session ended without an exception — reset backoff
                retryDelayMs = InitialRetryDelayMs;
                await Task.Delay((int)InitialRetryDelayMs, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Node session failed, retrying in {DelayMs}ms", retryDelayMs);
                await Task.Delay((int)retryDelayMs, ct).ConfigureAwait(false);
                retryDelayMs = Math.Min(retryDelayMs * 2, MaxRetryDelayMs);
            }
        }
    }

    // ── Node session lifecycle ─────────────────────────────────────────────────

    private async Task RunNodeSessionAsync(
        string                  uri,
        string[]                caps,
        string[]                commands,
        Dictionary<string, bool> permissions,
        CancellationToken       ct)
    {
        using var ws       = new ClientWebSocket();
        var       parsedUri = new Uri(uri);

        // Apply TLS pinning only for wss:// — ws:// is loopback only (enforced by GatewayUriNormalizer)
        if (parsedUri.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase))
            await ConfigureTlsPinningAsync(ws, parsedUri, ct);

        await ws.ConnectAsync(parsedUri, ct);
        _logger.LogInformation("Node session connected to {Uri}", uri);

        _activeNodeWs = ws;
        try
        {
            await RunReceiveLoopAsync(ws, caps, commands, permissions, ct);
        }
        finally
        {
            // Clear before the ws is disposed so TrySendEvent never sees a closed socket
            _activeNodeWs = null;
        }
    }

    // ── INodeEventSink ────────────────────────────────────────────────────────

    public void TrySendEvent(string eventName, string? payloadJson)
    {
        var ws = _activeNodeWs;
        if (ws is null || ws.State != WebSocketState.Open) return;

        // Fire-and-forget; swallow errors
        _ = Task.Run(async () =>
        {
            await _wsSendLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                if (_activeNodeWs is null || ws.State != WebSocketState.Open) return;

                var frame = JsonSerializer.Serialize(new
                {
                    type = "event",
                    @event = eventName,
                    // Deserialize to JsonElement so it can be embedded without escaping
                    payload = payloadJson != null
                        ? JsonSerializer.Deserialize<JsonElement>(payloadJson)
                        : (JsonElement?)null,
                });
                var bytes = Encoding.UTF8.GetBytes(frame);
                await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Node event send failed: {Event}", eventName);
            }
            finally
            {
                _wsSendLock.Release();
            }
        });
    }

    // ── TLS TOFU pinning ──────────────────────────────────────────────────────

    private async Task ConfigureTlsPinningAsync(ClientWebSocket ws, Uri uri, CancellationToken ct)
    {
        var stableId = $"{uri.Host}:{(uri.Port > 0 ? uri.Port : 443)}";

        // Pre-load so the sync callback never does async I/O on the TLS handshake thread
        var storedFp = await _pinStore.LoadFingerprintAsync(stableId, ct);

        ws.Options.RemoteCertificateValidationCallback = (_, cert, _, _) =>
        {
            if (cert is null) return false;

            var fp = GatewayTlsPinStore.ComputeFingerprint(cert);

            if (storedFp is null)
            {
                // TOFU: first connection to this host — store and trust
                _pinStore.StoreFingerprintAsync(stableId, fp, CancellationToken.None)
                    .GetAwaiter().GetResult();
                storedFp = fp;   // update capture so duplicate callbacks agree
                _logger.LogInformation("Node TLS TOFU pinned {StableId}", stableId);
                return true;
            }

            if (storedFp == fp) return true;

            _logger.LogError(
                "Node TLS pin mismatch for {StableId}: rejecting connection",
                stableId);
            return false;
        };
    }

    // ── Receive / dispatch loop ────────────────────────────────────────────────

    private async Task RunReceiveLoopAsync(
        ClientWebSocket          ws,
        string[]                 caps,
        string[]                 commands,
        Dictionary<string, bool> permissions,
        CancellationToken        ct)
    {
        // 64 KB initial buffer — grows on fragmented messages
        var    buffer          = new byte[65536];
        string? connectReqId  = null;

        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            var accumulated = new List<ArraySegment<byte>>();
            WebSocketReceiveResult result;

            try
            {
                do
                {
                    result = await ws.ReceiveAsync(buffer, ct);
                    accumulated.Add(new ArraySegment<byte>(buffer[..result.Count].ToArray()));
                }
                while (!result.EndOfMessage);
            }
            catch (WebSocketException ex) when (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
            {
                _logger.LogWarning("Node session WebSocket closed unexpectedly");
                return;
            }

            if (result.MessageType == WebSocketMessageType.Close) return;
            if (result.MessageType != WebSocketMessageType.Text) continue;

            var json = Encoding.UTF8.GetString(accumulated
                .SelectMany<ArraySegment<byte>, byte>(seg => seg)
                .ToArray());

            JsonElement root;
            try
            {
                using var doc = JsonDocument.Parse(json);
                root = doc.RootElement.Clone();
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(ex, "Malformed node frame");
                continue;
            }

            if (!root.TryGetProperty("type", out var typeProp)) continue;
            _logger.LogInformation("NODE-COORD: frame type={Type}", typeProp.GetString());

            switch (typeProp.GetString())
            {
                case "event":
                    var eventName = root.TryGetProperty("event", out var evt) ? evt.GetString() : null;
                    if (eventName == "connect.challenge")
                    {
                        // Extract nonce from payload — { type: "event", event: "connect.challenge", payload: { nonce: "..." } }
                        string? nonce = null;
                        if (root.TryGetProperty("payload", out var challengePayload) &&
                            challengePayload.TryGetProperty("nonce", out var nonceProp))
                        {
                            nonce = nonceProp.GetString()?.Trim();
                        }
                        if (string.IsNullOrEmpty(nonce))
                        {
                            _logger.LogError("NODE-COORD: connect.challenge missing nonce");
                            return;
                        }
                        _logger.LogInformation("NODE-COORD: connect.challenge nonce received");
                        connectReqId = await SendNodeConnectRequestAsync(ws, nonce, caps, commands, permissions, ct);
                    }
                    // Gateway sends invokes as push events: { type: "event", event: "node.invoke.request", payload: {...} }
                    else if (eventName == "node.invoke.request")
                    {
                        var payload = root.TryGetProperty("payload", out var pl) ? pl : (JsonElement?)null;
                        if (payload.HasValue)
                            await HandleNodeInvokeEventAsync(ws, payload.Value, ct);
                    }
                    else
                    {
                        _logger.LogDebug("Node socket event: {Event}", eventName);
                    }
                    break;

                case "res":
                    _logger.LogInformation("NODE-COORD: res frame: {Json}",
                        root.GetRawText().Length > 1000 ? root.GetRawText()[..1000] : root.GetRawText());
                    if (connectReqId is not null &&
                        root.TryGetProperty("id", out var idProp) &&
                        idProp.GetString() == connectReqId)
                    {
                        connectReqId = null;
                        // Check if the connect was rejected
                        var isOk = root.TryGetProperty("ok", out var okProp) && okProp.GetBoolean();
                        if (!isOk)
                        {
                            var errMsg = root.TryGetProperty("error", out var errProp) ? errProp.GetRawText() : "unknown";
                            _logger.LogError("Node connect REJECTED: {Error}", errMsg);
                            return; // Exit receive loop — will trigger retry with backoff
                        }
                        _logger.LogInformation("Node session handshake complete");
                        try
                        {
                            var sessionKey = await _rpc.MainSessionKeyAsync(ct: ct);
                            _nodeRuntime.UpdateMainSessionKey(sessionKey);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "Failed to fetch main session key for node runtime");
                        }
                    }
                    break;

                default:
                    _logger.LogDebug("Node socket unknown frame type={Type}", typeProp.GetString());
                    break;
            }
        }
    }

    // ── Connect handshake ──────────────────────────────────────────────────────

    private async Task<string> SendNodeConnectRequestAsync(
        ClientWebSocket          ws,
        string                   nonce,
        string[]                 caps,
        string[]                 commands,
        Dictionary<string, bool> permissions,
        CancellationToken        ct)
    {
        // RequireConfigAsync refreshes credentials and — for SSH remote mode — awaits
        // the tunnel ensure task so token/password are available before sending.
        string? token = null;
        string? password = null;
        try
        {
            var config = await _endpointStore.RequireConfigAsync(ct).ConfigureAwait(false);
            token    = config.Token;
            password = config.Password;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning("Endpoint not ready for node connect: {Reason}", ex.Message);
        }

        // URI user-info fallback: for installs where the token is only persisted in
        // GatewayEndpointUri (ws://token@host:port) and not in gateway.auth.token config.
        if (string.IsNullOrEmpty(token) && string.IsNullOrEmpty(password))
        {
            try
            {
                var s = await _settings.LoadAsync(ct).ConfigureAwait(false);
                if (!string.IsNullOrWhiteSpace(s.GatewayEndpointUri) &&
                    Uri.TryCreate(s.GatewayEndpointUri.Trim(), UriKind.Absolute, out var parsed) &&
                    !string.IsNullOrEmpty(parsed.UserInfo))
                {
                    var userToken = Uri.UnescapeDataString(parsed.UserInfo.Split(':')[0]);
                    if (!string.IsNullOrEmpty(userToken))
                        token = userToken;
                }
            }
            catch { /* proceed with no auth */ }
        }

        // Load or create device Ed25519 keypair
        var kpResult = await _keypairStorage.LoadAsync(ct);
        Ed25519KeyPair keyPair;
        if (kpResult.IsError)
        {
            var genResult = Ed25519KeyPair.Generate();
            if (genResult.IsError)
            {
                _logger.LogError("Failed to generate Ed25519 keypair: {Error}", genResult.FirstError.Description);
                throw new InvalidOperationException("Cannot generate device keypair");
            }
            keyPair = genResult.Value;
            await _keypairStorage.SaveAsync(keyPair, ct);
            _logger.LogInformation("NODE-COORD: generated new device keypair");
        }
        else
        {
            keyPair = kpResult.Value;
        }

        var deviceId  = keyPair.DeviceId();
        var publicKey = keyPair.PublicKeyBase64Url();
        var signedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Build v3 payload — matches GatewayDeviceAuthPayload.buildV3 exactly
        // "openclaw-macos" is the only node clientId the gateway accepts — BUG-009/011.
        // "openclaw-windows" is not in GATEWAY_CLIENT_IDS; adding it requires a gateway change
        // that will go into the PR (client-info.ts).  Use "openclaw-macos" for now so the
        // device-identity handshake (already implemented) succeeds locally.
        const string clientId     = "openclaw-macos";
        const string clientMode   = "node";
        const string role         = "node";
        const string scopeString  = "";
        const string platform     = "windows";
        const string deviceFamily = "desktop";

        var payloadV3 = string.Join("|",
            "v3", deviceId, clientId, clientMode, role, scopeString,
            signedAtMs.ToString(), token ?? "", nonce, platform, deviceFamily);

        var signature = keyPair.SignPayload(payloadV3);

        var id = Guid.NewGuid().ToString();

        // Build connect frame with device identity
        var connectParams = new Dictionary<string, object?>
        {
            ["minProtocol"] = 3,
            ["maxProtocol"] = 3,
            ["client"] = new
            {
                id          = clientId,
                version     = "1.0.0",
                platform,
                mode        = clientMode,
                displayName = "OpenClaw Windows",
                deviceFamily,
            },
            ["role"]        = role,
            ["scopes"]      = Array.Empty<string>(),
            ["caps"]        = caps,
            ["commands"]    = commands,
            ["permissions"] = permissions,
            ["auth"]        = !string.IsNullOrEmpty(token)
                                ? (object)new { token }
                                : !string.IsNullOrEmpty(password)
                                    ? new { password }
                                    : new { },
            ["locale"]      = "en-US",
            ["userAgent"]   = "openclaw-windows/1.0.0",
            ["device"] = new
            {
                id        = deviceId,
                publicKey,
                signature,
                signedAt  = signedAtMs,
                nonce,
            },
        };

        var frame = JsonSerializer.Serialize(new
        {
            type   = "req",
            id,
            method = "connect",
            @params = connectParams,
        });

        var bytes = Encoding.UTF8.GetBytes(frame);
        await _wsSendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
        }
        finally
        {
            _wsSendLock.Release();
        }
        return id;
    }

    // ── node.invoke dispatch ───────────────────────────────────────────────────

    // Handles node.invoke.request event payload
    // Payload structure: { id, nodeId, command, paramsJSON?, timeoutMs?, idempotencyKey? }
    private async Task HandleNodeInvokeEventAsync(ClientWebSocket ws, JsonElement payload, CancellationToken ct)
    {
        var id         = payload.TryGetProperty("id",         out var ip) ? ip.GetString()  ?? "" : "";
        var nodeId     = payload.TryGetProperty("nodeId",     out var ni) ? ni.GetString()  ?? "" : "";
        var command    = payload.TryGetProperty("command",    out var cp) ? cp.GetString()  ?? "" : "";
        // paramsJSON is a JSON string (not a parsed object) in the gateway protocol
        var paramsJson = payload.TryGetProperty("paramsJSON", out var pj) ? pj.GetString()  ?? "{}" : "{}";

        _logger.LogInformation("node.invoke.request id={Id} command={Command}", id, command);

        var response = await _mediator.Send(
            new DispatchNodeInvokeCommand(new NodeInvokeRequest(id, command, paramsJson)), ct);

        // Response sent as RPC: { type: "req", method: "node.invoke.result", params: { id, nodeId, ok, ... } }
        var resultParams = new Dictionary<string, object?>
        {
            ["id"]     = id,
            ["nodeId"] = nodeId,
            ["ok"]     = response.Ok,
        };
        if (response.PayloadJson != null)
            resultParams["payloadJSON"] = response.PayloadJson;
        if (response.Error != null)
            resultParams["error"] = new { code = "unavailable", message = response.Error };

        var responseJson = JsonSerializer.Serialize(new
        {
            type   = "req",
            id     = Guid.NewGuid().ToString(),
            method = "node.invoke.result",
            @params = resultParams,
        });

        var bytes = Encoding.UTF8.GetBytes(responseJson);
        await _wsSendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
        }
        finally
        {
            _wsSendLock.Release();
        }
    }

    // ── Caps / commands / permissions helpers ──────────────────────────────────

    private static string[] BuildCaps(bool cameraEnabled, bool locationEnabled, bool browserEnabled)
    {
        var caps = new List<string> { "canvas", "screen" };
        if (browserEnabled) caps.Add("browser");
        if (cameraEnabled)  caps.Add("camera");
        if (locationEnabled) caps.Add("location");
        return [.. caps];
    }

    private static string[] BuildCommands(string[] caps)
    {
        var commands = new List<string>
        {
            "canvas.present", "canvas.hide", "canvas.navigate",
            "canvas.eval", "canvas.snapshot",
            "canvas.a2ui.push", "canvas.a2ui.pushJSONL", "canvas.a2ui.reset",
            "screen.record",
            "system.notify", "system.which", "system.run",
            "system.execApprovals.get", "system.execApprovals.set",
        };

        var capsSet = new HashSet<string>(caps);
        if (capsSet.Contains("browser"))
            commands.Add("browser.proxy");
        if (capsSet.Contains("camera"))
            commands.AddRange(["camera.list", "camera.snap", "camera.clip"]);
        if (capsSet.Contains("location"))
            commands.Add("location.get");

        return [.. commands];
    }

    private async Task<bool> IsCameraEnabledAsync(CancellationToken ct)
    {
        // User must explicitly allow camera in settings before the node advertises the capability.
        var settings = await _settings.LoadAsync(ct);
        if (!settings.CameraEnabled) return false;

        var s = await _permissions.StatusAsync([Capability.Camera], ct);
        return s.TryGetValue(Capability.Camera, out var granted) && granted;
    }

    private async Task<bool> IsLocationEnabledAsync(CancellationToken ct)
    {
        var s = await _permissions.StatusAsync([Capability.Location], ct);
        return s.TryGetValue(Capability.Location, out var granted) && granted;
    }

    private async Task<Dictionary<string, bool>> BuildPermissionsAsync(CancellationToken ct)
    {
        var statuses = await _permissions.StatusAsync(null, ct);
        return statuses.ToDictionary(kv => CapabilityToProtocolKey(kv.Key), kv => kv.Value);
    }

    // Converts PascalCase Capability enum names to camelCase protocol keys
    // (e.g. ScreenRecording → "screenRecording") matching the gateway protocol.
    private static string CapabilityToProtocolKey(Capability cap)
    {
        var name = cap.ToString();
        return char.ToLowerInvariant(name[0]) + name[1..];
    }

    // ── Endpoint resolution ─

    private static string? ResolveEndpointUri(AppSettings settings)
    {
        var mode = settings.ConnectionMode != ConnectionMode.Unconfigured
            ? settings.ConnectionMode
            : !string.IsNullOrWhiteSpace(settings.RemoteUrl)
                ? ConnectionMode.Remote
                : settings.OnboardingSeen
                    ? ConnectionMode.Local
                    : ConnectionMode.Unconfigured;

        if (mode == ConnectionMode.Unconfigured) return null;

        string? rawUri = mode == ConnectionMode.Remote && settings.RemoteTransport == RemoteTransport.Ssh
            ? ResolveSshLocalUri(settings)
            : mode == ConnectionMode.Remote && !string.IsNullOrWhiteSpace(settings.RemoteUrl)
                ? settings.RemoteUrl
                : settings.GatewayEndpointUri;

        return GatewayUriNormalizer.Normalize(rawUri);
    }

    // The SSH tunnel forwards local port 18789 → remote gateway. Always use plain ws://
    // for the local tunnel endpoint — using wss://localhost would attempt TLS against
    // localhost, but the certificate is issued for the remote host, so hostname validation fails.
    private static string ResolveSshLocalUri(AppSettings settings) => "ws://localhost:18789";
}
