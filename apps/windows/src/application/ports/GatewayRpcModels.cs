using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenClawWindows.Application.Ports;

// ── Outgoing ──────────────────────────────────────────────────────────────────

public sealed record GatewayAgentInvocation(
    string Message,
    string SessionKey = "main",
    string? Thinking = null,
    bool Deliver = false,
    string? To = null,
    string Channel = "last",
    int? TimeoutSeconds = null,
    string? IdempotencyKey = null);

public sealed record ChatAttachment(string Type, string MimeType, string FileName, string Content);

// ── Cron return types ─────────────────────────────────────────────────────────

public sealed class GatewayCronSchedulerStatus
{
    [JsonPropertyName("enabled")] public bool Enabled { get; init; }
    [JsonPropertyName("storePath")] public string StorePath { get; init; } = string.Empty;
    [JsonPropertyName("jobs")] public int Jobs { get; init; }
    [JsonPropertyName("nextWakeAtMs")] public long? NextWakeAtMs { get; init; }
}

public sealed class GatewayCronJob
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("sessionKey")] public string? SessionKey { get; init; }
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("enabled")] public bool Enabled { get; init; }
    [JsonPropertyName("deleteAfterRun")] public bool? DeleteAfterRun { get; init; }
    [JsonPropertyName("createdAtMs")] public long CreatedAtMs { get; init; }
    [JsonPropertyName("updatedAtMs")] public long UpdatedAtMs { get; init; }
    // Variable-structure fields
    [JsonPropertyName("schedule")] public JsonElement Schedule { get; init; }
    [JsonPropertyName("sessionTarget")] public JsonElement SessionTarget { get; init; }
    [JsonPropertyName("wakeMode")] public JsonElement WakeMode { get; init; }
    [JsonPropertyName("payload")] public JsonElement Payload { get; init; }
    [JsonPropertyName("delivery")] public JsonElement? Delivery { get; init; }
    [JsonPropertyName("failureAlert")] public JsonElement? FailureAlert { get; init; }
    [JsonPropertyName("state")] public JsonElement State { get; init; }
}

public sealed class GatewayCronRunLogEntry
{
    [JsonPropertyName("ts")] public long Ts { get; init; }
    [JsonPropertyName("jobId")] public string JobId { get; init; } = string.Empty;
    [JsonPropertyName("action")] public string Action { get; init; } = string.Empty;
    [JsonPropertyName("status")] public JsonElement? Status { get; init; }
    [JsonPropertyName("error")] public string? Error { get; init; }
    [JsonPropertyName("summary")] public string? Summary { get; init; }
    [JsonPropertyName("delivered")] public bool? Delivered { get; init; }
    [JsonPropertyName("deliveryStatus")] public JsonElement? DeliveryStatus { get; init; }
    [JsonPropertyName("deliveryError")] public string? DeliveryError { get; init; }
    [JsonPropertyName("sessionId")] public string? SessionId { get; init; }
    [JsonPropertyName("sessionKey")] public string? SessionKey { get; init; }
    [JsonPropertyName("runAtMs")] public long? RunAtMs { get; init; }
    [JsonPropertyName("durationMs")] public int? DurationMs { get; init; }
    [JsonPropertyName("nextRunAtMs")] public long? NextRunAtMs { get; init; }
    [JsonPropertyName("model")] public string? Model { get; init; }
    [JsonPropertyName("provider")] public string? Provider { get; init; }
    [JsonPropertyName("jobName")] public string? JobName { get; init; }
}

// ── Session list ──────────────────────────────────────────────────────────────

public sealed class ChatSessionEntry
{
    [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;
    [JsonPropertyName("displayName")] public string? DisplayName { get; init; }
    [JsonPropertyName("updatedAt")] public double? UpdatedAt { get; init; }
    // current model for this session.
    [JsonPropertyName("model")] public string? Model { get; init; }

    [System.Text.Json.Serialization.JsonIgnore]
    public string DisplayLabel => DisplayName ?? Key;
}

// ── Exception ──────────────────────────────────────────────────────────────────

// Thrown by IGatewayRpcChannel when the gateway returns ok=false
public sealed class GatewayResponseException : Exception
{
    public string? Code { get; }

    public GatewayResponseException(string? code, string message) : base(message)
        => Code = code;
}
