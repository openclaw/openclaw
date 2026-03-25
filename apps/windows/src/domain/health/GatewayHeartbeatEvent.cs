using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Health;

public sealed record GatewayHeartbeatEvent(
    [property: JsonPropertyName("ts")]         double Ts,
    [property: JsonPropertyName("status")]     string Status,
    [property: JsonPropertyName("to")]         string? To,
    [property: JsonPropertyName("preview")]    string? Preview,
    [property: JsonPropertyName("durationMs")] double? DurationMs,
    [property: JsonPropertyName("hasMedia")]   bool? HasMedia,
    [property: JsonPropertyName("reason")]     string? Reason);
