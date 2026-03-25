using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Usage;

public sealed class GatewayUsageWindow
{
    [JsonPropertyName("label")]       public string Label { get; init; } = string.Empty;
    [JsonPropertyName("usedPercent")] public double UsedPercent { get; init; }
    // Epoch-milliseconds as double, matching Swift's resetAt: Double? field.
    [JsonPropertyName("resetAt")]     public double? ResetAt { get; init; }
}
