using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Usage;

// Fields are flattened directly — same JSON wire format.
public sealed class GatewayCostUsageDay
{
    [JsonPropertyName("date")]               public string Date { get; init; } = string.Empty;
    [JsonPropertyName("input")]              public int Input { get; init; }
    [JsonPropertyName("output")]             public int Output { get; init; }
    [JsonPropertyName("cacheRead")]          public int CacheRead { get; init; }
    [JsonPropertyName("cacheWrite")]         public int CacheWrite { get; init; }
    [JsonPropertyName("totalTokens")]        public int TotalTokens { get; init; }
    [JsonPropertyName("totalCost")]          public double TotalCost { get; init; }
    [JsonPropertyName("missingCostEntries")] public int MissingCostEntries { get; init; }
}
