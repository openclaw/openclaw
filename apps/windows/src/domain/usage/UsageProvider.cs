using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Usage;

public sealed class GatewayUsageProvider
{
    [JsonPropertyName("provider")]    public string Provider { get; init; } = string.Empty;
    [JsonPropertyName("displayName")] public string DisplayName { get; init; } = string.Empty;
    [JsonPropertyName("windows")]     public List<GatewayUsageWindow> Windows { get; init; } = [];
    [JsonPropertyName("plan")]        public string? Plan { get; init; }
    [JsonPropertyName("error")]       public string? Error { get; init; }
}
