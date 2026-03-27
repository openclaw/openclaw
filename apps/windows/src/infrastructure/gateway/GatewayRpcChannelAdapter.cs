using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using OpenClawWindows.Application.Onboarding;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.AgentEvents;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Manages in-flight RPC requests over the gateway WebSocket.
/// Each send registers a pending TaskCompletionSource keyed by request ID;
/// responses are correlated by the receive loop via RouteResponse().
/// </summary>
internal sealed class GatewayRpcChannelAdapter : IGatewayRpcChannel, IGatewayMessageRouter, IPairingEventSource, IChatPushSource, IExecApprovalEventSource
{
    // Tunables
    private const int DefaultTimeoutMs = 15000;
    private const int HandshakeGateTimeoutMs = 30000; // max wait for hello-ok before failing an RPC

    private readonly IGatewayWebSocket _ws;
    private readonly GatewayConnection _connection;
    private readonly IWorkActivityStore _workActivity;
    private readonly IAgentEventStore _agentEvents;
    private readonly ICronJobsStore _cronJobs;
    private readonly IHeartbeatStore _heartbeatStore;
    private readonly ILogger<GatewayRpcChannelAdapter> _logger;

    // Pending RPC requests keyed by UUID — completed by the receive loop (GAP-017)
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>>
        _pending = new();

    // Handshake gate
    // RPCs block here until the receive loop signals hello-ok via NotifyHandshakeComplete().
    private readonly object _gateLock = new();
    private TaskCompletionSource _handshakeGate = new(TaskCreationOptions.RunContinuationsAsynchronously);

    // ── IPairingEventSource ────────────────────────────────────────────────────
    public event Action<JsonElement>? DevicePairRequested;
    public event Action<JsonElement>? DevicePairResolved;
    public event Action<JsonElement>? NodePairRequested;
    public event Action<JsonElement>? NodePairResolved;
    public event Action? GatewaySnapshot;
    public event Action? GatewaySeqGap;

    // Presence push events
    public event Action<JsonElement>? PresenceReceived;

    // Chat push events
    public event Action<JsonElement>? ChatEventReceived;

    // Agent push events
    public event Action<JsonElement>? AgentEventReceived;

    // Health, tick, seqGap
    public event Action<bool>? HealthReceived;
    public event Action? TickReceived;
    public event Action? SeqGapReceived;

    // Exec approval push events
    public event Action<JsonElement>? ExecApprovalRequested;

    private static readonly JsonSerializerOptions SerializeOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly JsonSerializerOptions DeserializeOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public GatewayRpcChannelAdapter(
        IGatewayWebSocket ws,
        GatewayConnection connection,
        IWorkActivityStore workActivity,
        IAgentEventStore agentEvents,
        ICronJobsStore cronJobs,
        IHeartbeatStore heartbeatStore,
        ILogger<GatewayRpcChannelAdapter> logger)
    {
        _ws = ws;
        _connection = connection;
        _workActivity = workActivity;
        _agentEvents = agentEvents;
        _cronJobs = cronJobs;
        _heartbeatStore = heartbeatStore;
        _logger = logger;
    }

    // ── IGatewayMessageRouter ─────────────────────────────────────────────────

    public void RouteResponse(string id, bool ok, JsonElement? payload, JsonElement? error)
    {
        _logger.LogInformation("RPC response id={Id} ok={Ok} error={Err}", id, ok,
            error?.GetRawText() ?? "none");
        if (!_pending.TryRemove(id, out var tcs)) return;

        if (!ok)
        {
            var code = error?.TryGetProperty("code", out var c) == true ? c.GetString() : null;
            var msg = error?.TryGetProperty("message", out var m) == true ? m.GetString() : "gateway error";
            tcs.TrySetException(new GatewayResponseException(code, msg ?? "gateway error"));
            return;
        }

        tcs.TrySetResult(payload ?? default);
    }

    public void RouteEvent(string eventName, JsonElement? payload)
    {
        _logger.LogDebug("Gateway push event={Event}", eventName);

        // Gateway-level state events.
        // snapshot = hello-ok arrived. Extract health.ok; defaults to true if the field is absent.
        if (eventName == "snapshot")
        {
            GatewaySnapshot?.Invoke();
            var healthOk = true;
            if (payload.HasValue &&
                payload.Value.TryGetProperty("snapshot", out var snap) &&
                snap.TryGetProperty("health", out var health) &&
                health.TryGetProperty("ok", out var okEl))
                healthOk = okEl.ValueKind == JsonValueKind.True;
            HealthReceived?.Invoke(healthOk);
            return;
        }
        if (eventName == "tick")     { TickReceived?.Invoke();     return; }
        if (eventName == "seqGap")
        {
            GatewaySeqGap?.Invoke();
            SeqGapReceived?.Invoke();
            return;
        }

        // Pairing and exec-approval push events — forward payload to subscribing orchestrators.
        if (payload.HasValue)
        {
            switch (eventName)
            {
                case "device.pair.requested":    DevicePairRequested?.Invoke(payload.Value);    return;
                case "device.pair.resolved":     DevicePairResolved?.Invoke(payload.Value);     return;
                case "node.pair.requested":      NodePairRequested?.Invoke(payload.Value);      return;
                case "node.pair.resolved":       NodePairResolved?.Invoke(payload.Value);       return;
                case "exec.approval.requested":  ExecApprovalRequested?.Invoke(payload.Value);  return;
            }
        }

        if (!payload.HasValue) return;
        var p = payload.Value;

        // "health" push
        if (eventName == "health")
        {
            var ok = p.TryGetProperty("ok", out var okEl) && okEl.ValueKind == JsonValueKind.True;
            HealthReceived?.Invoke(ok);
            return;
        }

        // "heartbeat" push
        if (eventName == "heartbeat")
        {
            _heartbeatStore.HandleHeartbeat(p);
            return;
        }

        // "cron" push events
        // "presence" push
        if (eventName == "presence")
        {
            PresenceReceived?.Invoke(p);
            return;
        }

        // "chat" push
        if (eventName == "chat")
        {
            _logger.LogInformation("CHAT PUSH received: {Payload}", p.GetRawText());
            ChatEventReceived?.Invoke(p);
            return;
        }

        if (eventName == "cron")
        {
            var jobId  = GetString(p, "jobId")  ?? string.Empty;
            var action = GetString(p, "action") ?? string.Empty;
            _cronJobs.HandleCronEvent(jobId, action);
            return;
        }

        // "agent" is the single push event name
        // The stream field inside the payload discriminates job/tool/assistant events.
        if (eventName != "agent") return;

        var runId = GetString(p, "runId") ?? string.Empty;
        var seq = p.TryGetProperty("seq", out var seqEl) ? seqEl.GetInt32() : 0;
        var stream = GetString(p, "stream") ?? string.Empty;
        var tsMs = p.TryGetProperty("ts", out var tsEl) ? tsEl.GetDouble() : 0;
        var summary = GetString(p, "summary");

        var hasData = p.TryGetProperty("data", out var dataEl)
                   && dataEl.ValueKind == JsonValueKind.Object;
        var dataJson = hasData ? dataEl.GetRawText() : "{}";

        _agentEvents.Append(new AgentEvent(runId, seq, stream, tsMs, dataJson, summary));

        // Expose raw agent push to chat VM for streaming text + tool calls.
        _logger.LogInformation("AGENT PUSH received: stream={Stream} runId={RunId}", stream, runId);
        AgentEventReceived?.Invoke(p);

        // Route job/tool streams to WorkActivityStore for tray icon badge state.
        if (hasData)
        {
            var sessionKey = GetString(dataEl, "sessionKey") ?? "main";
            switch (stream.ToLowerInvariant())
            {
                case "job":
                    _workActivity.HandleJob(sessionKey, GetString(dataEl, "state") ?? string.Empty);
                    break;
                case "tool":
                    var phase = GetString(dataEl, "phase") ?? string.Empty;
                    var toolName = GetString(dataEl, "name");
                    var meta = GetString(dataEl, "meta");
                    JsonElement? args = dataEl.TryGetProperty("args", out var a)
                                     && a.ValueKind == JsonValueKind.Object
                        ? a.Clone()
                        : null;
                    _workActivity.HandleTool(sessionKey, phase, toolName, meta, args);
                    break;
            }
        }
    }

    private static string? GetString(JsonElement el, string key) =>
        el.TryGetProperty(key, out var prop) && prop.ValueKind == JsonValueKind.String
            ? prop.GetString()
            : null;

    // ── Handshake gate

    public void NotifyHandshakeComplete()
    {
        lock (_gateLock)
        {
            _handshakeGate.TrySetResult();
        }
    }

    public void ResetHandshakeGate()
    {
        lock (_gateLock)
        {
            if (_handshakeGate.Task.IsCompleted)
                _handshakeGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }
    }

    // ── IGatewayRpcChannel — primitives ────────────────────────────────────────

    public async Task<byte[]> RequestRawAsync(
        string method,
        Dictionary<string, object?>? parameters = null,
        int? timeoutMs = null,
        CancellationToken ct = default)
    {
        // Wait for hello-ok handshake before sending any RPC — prevents PolicyViolation
        // from the gateway when RPCs arrive before the connect handshake completes.
        Task gateTask;
        lock (_gateLock) { gateTask = _handshakeGate.Task; }
        if (!gateTask.IsCompleted)
        {
            _logger.LogDebug("RPC '{Method}' waiting for handshake gate", method);
            using var gateCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            gateCts.CancelAfter(HandshakeGateTimeoutMs);
            try
            {
                await gateTask.WaitAsync(gateCts.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new TimeoutException(
                    $"Gateway handshake not completed within {HandshakeGateTimeoutMs}ms — RPC '{method}' aborted");
            }
        }

        var id = Guid.NewGuid().ToString();
        var tcs = new TaskCompletionSource<JsonElement>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;

        try
        {
            var node = new JsonObject
            {
                ["type"] = "req",
                ["id"] = id,
                ["method"] = method,
                ["params"] = parameters is not null
                    ? JsonSerializer.SerializeToNode(parameters, SerializeOptions)
                    : null,
            };

            _logger.LogInformation("RPC send method={Method} id={Id}", method, id);
            var sendResult = await _ws.SendAsync(node.ToJsonString(), ct);
            if (sendResult.IsError)
            {
                _pending.TryRemove(id, out _);
                throw new InvalidOperationException(
                    $"Gateway send failed: {sendResult.FirstError.Description}");
            }

            var effective = timeoutMs ?? DefaultTimeoutMs;
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(effective);

            var payload = await tcs.Task.WaitAsync(timeoutCts.Token);
            return JsonSerializer.SerializeToUtf8Bytes(payload, SerializeOptions);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            _pending.TryRemove(id, out _);
            throw new TimeoutException(
                $"Gateway request '{method}' timed out after {timeoutMs ?? DefaultTimeoutMs}ms");
        }
        catch
        {
            _pending.TryRemove(id, out _);
            throw;
        }
    }

    public async Task<T> RequestDecodedAsync<T>(
        string method,
        Dictionary<string, object?>? parameters = null,
        int? timeoutMs = null,
        CancellationToken ct = default) where T : class
    {
        var data = await RequestRawAsync(method, parameters, timeoutMs, ct);
        return JsonSerializer.Deserialize<T>(data, DeserializeOptions)
            ?? throw new InvalidOperationException(
                $"Gateway response for '{method}' deserialized as null");
    }

    // ── Agent / status ─────────────────────────────────────────────────────────

    public async Task<(bool Ok, string? Error)> SendAgentAsync(
        GatewayAgentInvocation invocation,
        CancellationToken ct = default)
    {
        var trimmed = invocation.Message.Trim();
        if (string.IsNullOrEmpty(trimmed)) return (false, "message empty");

        var sessionKey = CanonicalizeSessionKey(invocation.SessionKey);
        var parameters = new Dictionary<string, object?>
        {
            ["message"] = trimmed,
            ["sessionKey"] = sessionKey,
            ["thinking"] = invocation.Thinking ?? "default",
            ["deliver"] = invocation.Deliver,
            ["to"] = invocation.To ?? string.Empty,
            ["channel"] = invocation.Channel,
            ["idempotencyKey"] = invocation.IdempotencyKey ?? Guid.NewGuid().ToString(),
        };
        if (invocation.TimeoutSeconds.HasValue)
            parameters["timeout"] = invocation.TimeoutSeconds.Value;

        try
        {
            await RequestRawAsync("agent", parameters, null, ct);
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    public async Task<(bool Ok, string? Error)> StatusAsync(CancellationToken ct = default)
    {
        try
        {
            await RequestRawAsync("status", null, null, ct);
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    public async Task<bool> SetHeartbeatsAsync(bool enabled, CancellationToken ct = default)
    {
        try
        {
            await RequestRawAsync("set-heartbeats",
                new Dictionary<string, object?> { ["enabled"] = enabled }, null, ct);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "setHeartbeats failed");
            return false;
        }
    }

    public async Task<Domain.Health.GatewayHeartbeatEvent?> LastHeartbeatAsync(CancellationToken ct = default)
    {
        var raw = await RequestRawAsync("last-heartbeat", ct: ct);
        return JsonSerializer.Deserialize<Domain.Health.GatewayHeartbeatEvent>(raw, DeserializeOptions);
    }

    public async Task SendSystemEventAsync(
        Dictionary<string, object?> parameters,
        CancellationToken ct = default)
    {
        try { await RequestRawAsync("system-event", parameters, null, ct); }
        catch { /* best-effort */ }
    }

    // ── Health ─────────────────────────────────────────────────────────────────

    public async Task<bool> HealthOkAsync(int timeoutMs = 8000, CancellationToken ct = default)
    {
        try
        {
            var data = await RequestRawAsync("health", null, timeoutMs, ct);
            using var doc = JsonDocument.Parse(data);
            // Gateway returns { ok: true } or { ok: false } — treat missing field as true (tolerate)
            return !doc.RootElement.TryGetProperty("ok", out var ok) || ok.GetBoolean();
        }
        catch
        {
            return false;
        }
    }

    // ── Config ─────────────────────────────────────────────────────────────────

    public Task<byte[]> ConfigGetAsync(int? timeoutMs = null, CancellationToken ct = default)
        => RequestRawAsync("config.get", null, timeoutMs, ct);

    public Task ConfigSetAsync(string rawJson, string? baseHash = null, CancellationToken ct = default)
    {
        // config.set requires { raw: string, baseHash?: string } — never pass a config object directly.
        var parameters = new Dictionary<string, object?> { ["raw"] = rawJson };
        if (baseHash is not null)
            parameters["baseHash"] = baseHash;
        return RequestRawAsync("config.set", parameters, null, ct);
    }

    public Task ConfigPatchAsync(
        string id,
        Dictionary<string, object?> patch,
        CancellationToken ct = default)
        => RequestRawAsync("config.patch",
            new Dictionary<string, object?> { ["id"] = id, ["patch"] = patch }, null, ct);

    public async Task<string> MainSessionKeyAsync(
        int timeoutMs = 15000,
        CancellationToken ct = default)
    {
        // Use the session key cached in GatewayConnection from hello-ok if available
        var cached = _connection.SessionKey;
        if (!string.IsNullOrEmpty(cached)) return cached;

        // Fall back to config.get to determine session scope
        try
        {
            var data = await ConfigGetAsync(timeoutMs, ct);
            return ParseMainSessionKey(data);
        }
        catch
        {
            return "main";
        }
    }

    // ── Skills ─────────────────────────────────────────────────────────────────

    public async Task<JsonElement> SkillsStatusAsync(CancellationToken ct = default)
        => ParseRootElement(await RequestRawAsync("skills.status", null, null, ct));

    public async Task<JsonElement> SkillsInstallAsync(
        string name,
        string installId,
        int? timeoutMs = null,
        CancellationToken ct = default)
    {
        var parameters = new Dictionary<string, object?>
            { ["name"] = name, ["installId"] = installId };
        if (timeoutMs.HasValue) parameters["timeoutMs"] = timeoutMs.Value;
        return ParseRootElement(await RequestRawAsync("skills.install", parameters, timeoutMs, ct));
    }

    public async Task<JsonElement> SkillsUpdateAsync(
        string skillKey,
        bool? enabled = null,
        string? apiKey = null,
        Dictionary<string, string>? env = null,
        CancellationToken ct = default)
    {
        var parameters = new Dictionary<string, object?> { ["skillKey"] = skillKey };
        if (enabled.HasValue) parameters["enabled"] = enabled.Value;
        if (apiKey is not null) parameters["apiKey"] = apiKey;
        if (env is { Count: > 0 }) parameters["env"] = env;
        return ParseRootElement(await RequestRawAsync("skills.update", parameters, null, ct));
    }

    // ── Sessions ───────────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<ChatSessionEntry>> ListSessionsAsync(int? limit = null, CancellationToken ct = default)
    {
        var parameters = new Dictionary<string, object?>
        {
            ["includeGlobal"] = true,
            ["includeUnknown"] = false,
        };
        if (limit.HasValue) parameters["limit"] = limit.Value;

        var data = await RequestRawAsync("sessions.list", parameters, 15000, ct);
        using var doc = JsonDocument.Parse(data);
        if (!doc.RootElement.TryGetProperty("sessions", out var sessionsEl)
            || sessionsEl.ValueKind != JsonValueKind.Array)
            return Array.Empty<ChatSessionEntry>();

        var result = new List<ChatSessionEntry>();
        foreach (var item in sessionsEl.EnumerateArray())
        {
            try
            {
                result.Add(JsonSerializer.Deserialize<ChatSessionEntry>(item, DeserializeOptions)!);
            }
            catch { /* skip malformed entry */ }
        }
        return result;
    }

    public async Task<JsonElement> SessionsPreviewAsync(
        IEnumerable<string> keys,
        int? limit = null,
        int? maxChars = null,
        int? timeoutMs = null,
        CancellationToken ct = default)
    {
        var resolvedKeys = keys
            .Select(CanonicalizeSessionKey)
            .Where(k => !string.IsNullOrEmpty(k))
            .ToList();

        if (resolvedKeys.Count == 0)
            return JsonSerializer.Deserialize<JsonElement>("{\"ts\":0,\"previews\":[]}")!;

        var parameters = new Dictionary<string, object?> { ["keys"] = resolvedKeys };
        if (limit.HasValue) parameters["limit"] = limit.Value;
        if (maxChars.HasValue) parameters["maxChars"] = maxChars.Value;
        return ParseRootElement(
            await RequestRawAsync("sessions.preview", parameters, timeoutMs, ct));
    }

    // Returns empty list on any failure so the UI can hide the picker gracefully.
    public async Task<IReadOnlyList<ModelChoice>> ListModelsAsync(int timeoutMs = 15000, CancellationToken ct = default)
    {
        try
        {
            var data = await RequestRawAsync("models.list", null, timeoutMs, ct);
            using var doc = JsonDocument.Parse(data);
            if (!doc.RootElement.TryGetProperty("models", out var modelsEl)
                || modelsEl.ValueKind != JsonValueKind.Array)
                return Array.Empty<ModelChoice>();

            var result = new List<ModelChoice>();
            foreach (var item in modelsEl.EnumerateArray())
            {
                try { result.Add(JsonSerializer.Deserialize<ModelChoice>(item, DeserializeOptions)!); }
                catch { /* skip malformed entry */ }
            }
            return result;
        }
        catch
        {
            // Best-effort
            return Array.Empty<ModelChoice>();
        }
    }

    public async Task PatchSessionModelAsync(string sessionKey, string? model, CancellationToken ct = default)
    {
        var parameters = new Dictionary<string, object?> { ["key"] = sessionKey };
        // Explicit null resets the model to the gateway default
        parameters["model"] = (object?)model ?? (object?)null;
        await RequestRawAsync("sessions.patch", parameters, 15000, ct);
    }

    // ── Chat ───────────────────────────────────────────────────────────────────

    public Task SetActiveSessionKeyAsync(string sessionKey, CancellationToken ct = default)
    {
        // Operator clients receive chat events unconditionally — no gateway RPC needed.
        // chat.subscribe is a node-only RPC.
        return Task.CompletedTask;
    }

    public async Task<JsonElement> ChatHistoryAsync(
        string sessionKey,
        int? limit = null,
        int? timeoutMs = null,
        CancellationToken ct = default)
    {
        var parameters = new Dictionary<string, object?>
            { ["sessionKey"] = CanonicalizeSessionKey(sessionKey) };
        if (limit.HasValue) parameters["limit"] = limit.Value;
        return ParseRootElement(
            await RequestRawAsync("chat.history", parameters, timeoutMs, ct));
    }

    public async Task<JsonElement> ChatSendAsync(
        string sessionKey,
        string message,
        string thinking,
        string idempotencyKey,
        IEnumerable<ChatAttachment> attachments,
        int timeoutMs = 30000,
        CancellationToken ct = default)
    {
        var parameters = new Dictionary<string, object?>
        {
            ["sessionKey"] = CanonicalizeSessionKey(sessionKey),
            ["message"] = message,
            ["thinking"] = thinking,
            ["idempotencyKey"] = idempotencyKey,
            ["timeoutMs"] = timeoutMs,
        };

        var attList = attachments.ToList();
        if (attList.Count > 0)
        {
            parameters["attachments"] = attList.Select(a => new Dictionary<string, string>
            {
                ["type"] = a.Type,
                ["mimeType"] = a.MimeType,
                ["fileName"] = a.FileName,
                ["content"] = a.Content,
            }).ToList();
        }

        return ParseRootElement(
            await RequestRawAsync("chat.send", parameters, timeoutMs, ct));
    }

    public async Task<bool> ChatAbortAsync(
        string sessionKey,
        string runId,
        CancellationToken ct = default)
    {
        var data = await RequestRawAsync("chat.abort",
            new Dictionary<string, object?>
            {
                ["sessionKey"] = CanonicalizeSessionKey(sessionKey),
                ["runId"] = runId,
            }, null, ct);

        using var doc = JsonDocument.Parse(data);
        return doc.RootElement.TryGetProperty("aborted", out var ab) && ab.GetBoolean();
    }

    public async Task TalkModeAsync(bool enabled, string? phase = null, CancellationToken ct = default)
    {
        var parameters = new Dictionary<string, object?> { ["enabled"] = enabled };
        if (phase is not null) parameters["phase"] = phase;
        try { await RequestRawAsync("talk.mode", parameters, null, ct); }
        catch { /* best-effort */ }
    }

    // ── VoiceWake ──────────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<string>> VoiceWakeGetTriggersAsync(CancellationToken ct = default)
    {
        var data = await RequestRawAsync("voicewake.get", null, null, ct);
        using var doc = JsonDocument.Parse(data);
        if (!doc.RootElement.TryGetProperty("triggers", out var triggersEl)
            || triggersEl.ValueKind != JsonValueKind.Array)
            return Array.Empty<string>();

        return triggersEl.EnumerateArray()
            .Select(el => el.GetString() ?? string.Empty)
            .Where(s => !string.IsNullOrEmpty(s))
            .ToList();
    }

    public async Task VoiceWakeSetTriggersAsync(
        IEnumerable<string> triggers,
        CancellationToken ct = default)
    {
        try
        {
            await RequestRawAsync("voicewake.set",
                new Dictionary<string, object?> { ["triggers"] = triggers.ToList() },
                10000, ct);
        }
        catch { /* best-effort */ }
    }

    // ── Node pairing ───────────────────────────────────────────────────────────

    public Task NodePairApproveAsync(string requestId, CancellationToken ct = default)
        => RequestRawAsync("node.pair.approve",
            new Dictionary<string, object?> { ["requestId"] = requestId }, 10000, ct);

    public Task NodePairRejectAsync(string requestId, CancellationToken ct = default)
        => RequestRawAsync("node.pair.reject",
            new Dictionary<string, object?> { ["requestId"] = requestId }, 10000, ct);

    // ── Device pairing ─────────────────────────────────────────────────────────

    public Task<byte[]> DevicePairListAsync(int? timeoutMs = null, CancellationToken ct = default)
        => RequestRawAsync("device.pair.list", null, timeoutMs, ct);

    public Task<byte[]> NodePairListAsync(int? timeoutMs = null, CancellationToken ct = default)
        => RequestRawAsync("node.pair.list", null, timeoutMs, ct);

    public Task DevicePairApproveAsync(string requestId, CancellationToken ct = default)
        => RequestRawAsync("device.pair.approve",
            new Dictionary<string, object?> { ["requestId"] = requestId }, 10000, ct);

    public Task DevicePairRejectAsync(string requestId, CancellationToken ct = default)
        => RequestRawAsync("device.pair.reject",
            new Dictionary<string, object?> { ["requestId"] = requestId }, 10000, ct);

    // ── Exec approvals ─────────────────────────────────────────────────────────

    public Task ExecApprovalResolveAsync(
        string requestId,
        string decision,
        CancellationToken ct = default)
        => RequestRawAsync("exec.approval.resolve",
            new Dictionary<string, object?> { ["id"] = requestId, ["decision"] = decision },
            null, ct);

    // ── Onboarding wizard ──────────────────────────────────────────────────────

    public async Task<WizardStartRpcResult> WizardStartAsync(
        string? workspace   = null,
        int?    timeoutMs   = null,
        CancellationToken ct = default)
    {
        var p = new Dictionary<string, object?> { ["mode"] = "local" };
        if (!string.IsNullOrWhiteSpace(workspace)) p["workspace"] = workspace;

        var data = await RequestRawAsync("wizard.start", p, timeoutMs ?? 30_000, ct);
        using var doc = JsonDocument.Parse(data);
        var root = doc.RootElement;

        var sessionId = root.TryGetProperty("sessionId", out var sidEl) ? sidEl.GetString() ?? "" : "";
        var done      = root.TryGetProperty("done",      out var dEl)   && dEl.GetBoolean();
        var step      = WizardDtoHelpers.DecodeStep(root.TryGetProperty("step", out var stEl) ? stEl : null);
        var status    = WizardDtoHelpers.StatusString(root.TryGetProperty("status", out var stEl2) ? stEl2 : null);
        var error     = root.TryGetProperty("error",  out var eEl) ? eEl.GetString() : null;

        return new WizardStartRpcResult(sessionId, done, step, status, error);
    }

    public async Task<WizardNextRpcResult> WizardNextAsync(
        string       sessionId,
        string       stepId,
        JsonElement? value     = null,
        int?         timeoutMs = null,
        CancellationToken ct   = default)
    {
        var answer = new Dictionary<string, object?> { ["stepId"] = stepId };
        if (value.HasValue) answer["value"] = value.Value;

        var p = new Dictionary<string, object?> { ["sessionId"] = sessionId, ["answer"] = answer };

        var data = await RequestRawAsync("wizard.next", p, timeoutMs ?? 60_000, ct);
        using var doc = JsonDocument.Parse(data);
        var root = doc.RootElement;

        var done   = root.TryGetProperty("done",   out var dEl)  && dEl.GetBoolean();
        var step   = WizardDtoHelpers.DecodeStep(root.TryGetProperty("step", out var stEl) ? stEl : null);
        var status = WizardDtoHelpers.StatusString(root.TryGetProperty("status", out var stEl2) ? stEl2 : null);
        var error  = root.TryGetProperty("error",  out var eEl)  ? eEl.GetString() : null;

        return new WizardNextRpcResult(done, step, status, error);
    }

    public async Task<string?> WizardCancelAsync(string sessionId, CancellationToken ct = default)
    {
        var data = await RequestRawAsync("wizard.cancel",
            new Dictionary<string, object?> { ["sessionId"] = sessionId }, 10_000, ct);
        using var doc = JsonDocument.Parse(data);
        var root = doc.RootElement;
        return WizardDtoHelpers.StatusString(root.TryGetProperty("status", out var stEl) ? stEl : null);
    }

    // ── Cron ───────────────────────────────────────────────────────────────────

    public Task<GatewayCronSchedulerStatus> CronStatusAsync(CancellationToken ct = default)
        => RequestDecodedAsync<GatewayCronSchedulerStatus>("cron.status", null, null, ct);

    public async Task<IReadOnlyList<GatewayCronJob>> CronListAsync(
        bool includeDisabled = true,
        CancellationToken ct = default)
    {
        var data = await RequestRawAsync("cron.list",
            new Dictionary<string, object?> { ["includeDisabled"] = includeDisabled },
            null, ct);

        using var doc = JsonDocument.Parse(data);
        if (!doc.RootElement.TryGetProperty("jobs", out var jobsEl)
            || jobsEl.ValueKind != JsonValueKind.Array)
            return Array.Empty<GatewayCronJob>();

        var result = new List<GatewayCronJob>();
        var skipped = 0;
        foreach (var item in jobsEl.EnumerateArray())
        {
            try
            {
                result.Add(JsonSerializer.Deserialize<GatewayCronJob>(item, DeserializeOptions)!);
            }
            catch { skipped++; }
        }

        if (skipped > 0)
            _logger.LogWarning("cron.list skipped {Count} malformed jobs", skipped);

        return result;
    }

    public async Task<IReadOnlyList<GatewayCronRunLogEntry>> CronRunsAsync(
        string jobId,
        int limit = 200,
        CancellationToken ct = default)
    {
        var data = await RequestRawAsync("cron.runs",
            new Dictionary<string, object?> { ["id"] = jobId, ["limit"] = limit },
            null, ct);

        using var doc = JsonDocument.Parse(data);
        if (!doc.RootElement.TryGetProperty("entries", out var entriesEl)
            || entriesEl.ValueKind != JsonValueKind.Array)
            return Array.Empty<GatewayCronRunLogEntry>();

        var result = new List<GatewayCronRunLogEntry>();
        var skipped = 0;
        foreach (var item in entriesEl.EnumerateArray())
        {
            try
            {
                result.Add(
                    JsonSerializer.Deserialize<GatewayCronRunLogEntry>(item, DeserializeOptions)!);
            }
            catch { skipped++; }
        }

        if (skipped > 0)
            _logger.LogWarning("cron.runs skipped {Count} malformed entries", skipped);

        return result;
    }

    public Task CronRunAsync(string jobId, bool force = true, CancellationToken ct = default)
        => RequestRawAsync("cron.run",
            new Dictionary<string, object?>
            {
                ["id"] = jobId,
                ["mode"] = force ? "force" : "due",
            }, 20000, ct);

    public Task CronRemoveAsync(string jobId, CancellationToken ct = default)
        => RequestRawAsync("cron.remove",
            new Dictionary<string, object?> { ["id"] = jobId }, null, ct);

    public Task CronUpdateAsync(
        string jobId,
        Dictionary<string, object?> patch,
        CancellationToken ct = default)
        => RequestRawAsync("cron.update",
            new Dictionary<string, object?> { ["id"] = jobId, ["patch"] = patch }, null, ct);

    public Task CronAddAsync(
        Dictionary<string, object?> payload,
        CancellationToken ct = default)
        => RequestRawAsync("cron.add", payload, null, ct);

    // ── Helpers ───────────────────────────────────────────────────────────────

    private string CanonicalizeSessionKey(string raw)
    {
        var trimmed = raw.Trim();
        if (string.IsNullOrEmpty(trimmed)) return trimmed;

        // Resolve "main" alias to the actual session key from hello-ok.
        var mainKey = _connection.SessionKey;
        if (string.IsNullOrEmpty(mainKey)) return trimmed;
        return trimmed == "main" ? mainKey : trimmed;
    }

    private static string ParseMainSessionKey(byte[] data)
    {
        using var doc = JsonDocument.Parse(data);
        string? scope = null;
        if (doc.RootElement.TryGetProperty("config", out var cfg)
            && cfg.TryGetProperty("session", out var session)
            && session.TryGetProperty("scope", out var scopeEl))
            scope = scopeEl.GetString()?.Trim();

        return scope == "global" ? "global" : "main";
    }

    private static JsonElement ParseRootElement(byte[] data)
    {
        // Deserialize to a standalone JsonElement (backed by its own memory, safe to return)
        return JsonSerializer.Deserialize<JsonElement>(data, DeserializeOptions);
    }
}
