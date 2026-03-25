using System.Globalization;
using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Usage;

public sealed class GatewayCostUsageTotals
{
    [JsonPropertyName("input")]              public int Input { get; init; }
    [JsonPropertyName("output")]             public int Output { get; init; }
    [JsonPropertyName("cacheRead")]          public int CacheRead { get; init; }
    [JsonPropertyName("cacheWrite")]         public int CacheWrite { get; init; }
    [JsonPropertyName("totalTokens")]        public int TotalTokens { get; init; }
    [JsonPropertyName("totalCost")]          public double TotalCost { get; init; }
    [JsonPropertyName("missingCostEntries")] public int MissingCostEntries { get; init; }
}

public sealed class GatewayCostUsageSummary
{
    [JsonPropertyName("updatedAt")] public double UpdatedAt { get; init; }
    [JsonPropertyName("days")]      public int Days { get; init; }
    [JsonPropertyName("daily")]     public List<GatewayCostUsageDay> Daily { get; init; } = [];
    [JsonPropertyName("totals")]    public GatewayCostUsageTotals Totals { get; init; } = new();
}

public static class CostUsageFormatting
{
    // null or non-finite → null
    // value >= 0.01 → "$X.XX"  (both the ≥1 and ≥0.01 branches use %.2f in Swift)
    // value < 0.01  → "$X.XXXX"
    public static string? FormatUsd(double? value)
    {
        if (value is not { } v || !double.IsFinite(v)) return null;
        if (v >= 1)    return v.ToString("$0.00", CultureInfo.InvariantCulture);
        if (v >= 0.01) return v.ToString("$0.00", CultureInfo.InvariantCulture);
        return v.ToString("$0.0000", CultureInfo.InvariantCulture);
    }

    // null → null
    // safe = max(0, value)
    // >= 1_000_000 → "X.Xm"
    // >= 10_000    → "Xk"  (0 decimal)
    // >= 1_000     → "X.Xk" (1 decimal)
    // else         → integer string
    public static string? FormatTokenCount(int? value)
    {
        if (value is null) return null;
        var safe = Math.Max(0, value.Value);
        if (safe >= 1_000_000) return (safe / 1_000_000.0).ToString("0.0", CultureInfo.InvariantCulture) + "m";
        if (safe >= 10_000)    return (safe / 1_000.0).ToString("0", CultureInfo.InvariantCulture) + "k";
        if (safe >= 1_000)     return (safe / 1_000.0).ToString("0.0", CultureInfo.InvariantCulture) + "k";
        return safe.ToString(CultureInfo.InvariantCulture);
    }
}
