using System.Text.Json;
using OpenClawWindows.Application.Onboarding;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Typed RPC client for the OpenClaw gateway WebSocket protocol.
/// </summary>
public interface IGatewayRpcChannel
{
    // ── Primitives ─────────────────────────────────────────────────────────────
    Task<byte[]> RequestRawAsync(string method, Dictionary<string, object?>? parameters = null, int? timeoutMs = null, CancellationToken ct = default);
    Task<T> RequestDecodedAsync<T>(string method, Dictionary<string, object?>? parameters = null, int? timeoutMs = null, CancellationToken ct = default) where T : class;

    // ── Agent / status ─────────────────────────────────────────────────────────
    Task<(bool Ok, string? Error)> SendAgentAsync(GatewayAgentInvocation invocation, CancellationToken ct = default);
    Task<(bool Ok, string? Error)> StatusAsync(CancellationToken ct = default);
    Task<bool> SetHeartbeatsAsync(bool enabled, CancellationToken ct = default);
    // returns null if gateway has no heartbeat yet
    Task<Domain.Health.GatewayHeartbeatEvent?> LastHeartbeatAsync(CancellationToken ct = default);
    // Best-effort: swallows errors.
    Task SendSystemEventAsync(Dictionary<string, object?> parameters, CancellationToken ct = default);

    // ── Health ─────────────────────────────────────────────────────────────────
    Task<bool> HealthOkAsync(int timeoutMs = 8000, CancellationToken ct = default);

    // ── Config ─────────────────────────────────────────────────────────────────
    Task<byte[]> ConfigGetAsync(int? timeoutMs = null, CancellationToken ct = default);
    Task ConfigSetAsync(Dictionary<string, object?> root, CancellationToken ct = default);
    Task ConfigPatchAsync(string id, Dictionary<string, object?> patch, CancellationToken ct = default);
    // Returns "global" or "main"
    Task<string> MainSessionKeyAsync(int timeoutMs = 15000, CancellationToken ct = default);

    // ── Skills ─────────────────────────────────────────────────────────────────
    Task<JsonElement> SkillsStatusAsync(CancellationToken ct = default);
    Task<JsonElement> SkillsInstallAsync(string name, string installId, int? timeoutMs = null, CancellationToken ct = default);
    Task<JsonElement> SkillsUpdateAsync(string skillKey, bool? enabled = null, string? apiKey = null, Dictionary<string, string>? env = null, CancellationToken ct = default);

    // ── Sessions ───────────────────────────────────────────────────────────────
    Task<IReadOnlyList<ChatSessionEntry>> ListSessionsAsync(int? limit = null, CancellationToken ct = default);
    Task<JsonElement> SessionsPreviewAsync(IEnumerable<string> keys, int? limit = null, int? maxChars = null, int? timeoutMs = null, CancellationToken ct = default);
    Task<IReadOnlyList<ModelChoice>> ListModelsAsync(int timeoutMs = 15000, CancellationToken ct = default);
    Task PatchSessionModelAsync(string sessionKey, string? model, CancellationToken ct = default);

    // ── Chat ───────────────────────────────────────────────────────────────────
    // Best-effort no-op for operator clients
    // chat.subscribe is a node-only RPC; operator clients receive chat events unconditionally.
    Task SetActiveSessionKeyAsync(string sessionKey, CancellationToken ct = default);
    Task<JsonElement> ChatHistoryAsync(string sessionKey, int? limit = null, int? timeoutMs = null, CancellationToken ct = default);
    Task<JsonElement> ChatSendAsync(string sessionKey, string message, string thinking, string idempotencyKey, IEnumerable<ChatAttachment> attachments, int timeoutMs = 30000, CancellationToken ct = default);
    Task<bool> ChatAbortAsync(string sessionKey, string runId, CancellationToken ct = default);
    // Best-effort: swallows errors.
    Task TalkModeAsync(bool enabled, string? phase = null, CancellationToken ct = default);

    // ── VoiceWake ──────────────────────────────────────────────────────────────
    Task<IReadOnlyList<string>> VoiceWakeGetTriggersAsync(CancellationToken ct = default);
    // Best-effort: swallows errors.
    Task VoiceWakeSetTriggersAsync(IEnumerable<string> triggers, CancellationToken ct = default);

    // ── Node pairing ───────────────────────────────────────────────────────────
    Task<byte[]> NodePairListAsync(int? timeoutMs = null, CancellationToken ct = default);
    Task NodePairApproveAsync(string requestId, CancellationToken ct = default);
    Task NodePairRejectAsync(string requestId, CancellationToken ct = default);

    // ── Device pairing ─────────────────────────────────────────────────────────
    Task<byte[]> DevicePairListAsync(int? timeoutMs = null, CancellationToken ct = default);
    Task DevicePairApproveAsync(string requestId, CancellationToken ct = default);
    Task DevicePairRejectAsync(string requestId, CancellationToken ct = default);

    // ── Exec approvals ─────────────────────────────────────────────────────────
    Task ExecApprovalResolveAsync(string requestId, string decision, CancellationToken ct = default);

    // ── Onboarding wizard ──────────────────────────────────────────────────────
    Task<WizardStartRpcResult> WizardStartAsync(string? workspace = null, int? timeoutMs = null, CancellationToken ct = default);
    Task<WizardNextRpcResult> WizardNextAsync(string sessionId, string stepId, JsonElement? value = null, int? timeoutMs = null, CancellationToken ct = default);
    Task<string?> WizardCancelAsync(string sessionId, CancellationToken ct = default);

    // ── Cron ───────────────────────────────────────────────────────────────────
    Task<GatewayCronSchedulerStatus> CronStatusAsync(CancellationToken ct = default);
    // Lossy: malformed jobs are skipped and logged
    Task<IReadOnlyList<GatewayCronJob>> CronListAsync(bool includeDisabled = true, CancellationToken ct = default);
    // Lossy: malformed entries are skipped and logged
    Task<IReadOnlyList<GatewayCronRunLogEntry>> CronRunsAsync(string jobId, int limit = 200, CancellationToken ct = default);
    Task CronRunAsync(string jobId, bool force = true, CancellationToken ct = default);
    Task CronRemoveAsync(string jobId, CancellationToken ct = default);
    Task CronUpdateAsync(string jobId, Dictionary<string, object?> patch, CancellationToken ct = default);
    Task CronAddAsync(Dictionary<string, object?> payload, CancellationToken ct = default);
}
