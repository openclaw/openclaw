using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Health;

public sealed record HealthSnapshot(
    [property: JsonPropertyName("ok")]               bool? Ok,
    [property: JsonPropertyName("ts")]               double Ts,
    [property: JsonPropertyName("durationMs")]       double DurationMs,
    [property: JsonPropertyName("channels")]         IReadOnlyDictionary<string, ChannelSummary> Channels,
    [property: JsonPropertyName("channelOrder")]     IReadOnlyList<string>? ChannelOrder,
    [property: JsonPropertyName("channelLabels")]    IReadOnlyDictionary<string, string>? ChannelLabels,
    [property: JsonPropertyName("heartbeatSeconds")] int? HeartbeatSeconds,
    [property: JsonPropertyName("sessions")]         HealthSessions Sessions);

public sealed record ChannelSummary(
    [property: JsonPropertyName("configured")]  bool? Configured,
    [property: JsonPropertyName("linked")]      bool? Linked,
    [property: JsonPropertyName("authAgeMs")]   double? AuthAgeMs,
    [property: JsonPropertyName("probe")]       ChannelProbe? Probe,
    [property: JsonPropertyName("lastProbeAt")] double? LastProbeAt);

public sealed record ChannelProbe(
    [property: JsonPropertyName("ok")]        bool? Ok,
    [property: JsonPropertyName("status")]    int? Status,
    [property: JsonPropertyName("error")]     string? Error,
    [property: JsonPropertyName("elapsedMs")] double? ElapsedMs,
    [property: JsonPropertyName("bot")]       ProbeBot? Bot,
    [property: JsonPropertyName("webhook")]   ProbeWebhook? Webhook);

public sealed record ProbeBot([property: JsonPropertyName("username")] string? Username);
public sealed record ProbeWebhook([property: JsonPropertyName("url")] string? Url);

public sealed record HealthSessions(
    [property: JsonPropertyName("path")]   string Path,
    [property: JsonPropertyName("count")]  int Count,
    [property: JsonPropertyName("recent")] IReadOnlyList<HealthSessionInfo> Recent);

public sealed record HealthSessionInfo(
    [property: JsonPropertyName("key")]       string Key,
    [property: JsonPropertyName("updatedAt")] double? UpdatedAt,
    [property: JsonPropertyName("age")]       double? Age);
