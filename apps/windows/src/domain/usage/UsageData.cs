using System.Globalization;
using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Usage;

public sealed class GatewayUsageSummary
{
    [JsonPropertyName("updatedAt")]  public double UpdatedAt { get; init; }
    [JsonPropertyName("providers")] public List<GatewayUsageProvider> Providers { get; init; } = [];

    // For each provider selects the window with the highest usedPercent and
    // builds a UsageRow. Providers with no windows are skipped (compactMap).
    public IReadOnlyList<UsageRow> PrimaryRows()
    {
        var rows = new List<UsageRow>(Providers.Count);
        foreach (var provider in Providers)
        {
            if (provider.Windows.Count == 0) continue;

            // Mirror: provider.windows.max(by: { $0.usedPercent < $1.usedPercent })
            var window = provider.Windows.MaxBy(w => w.UsedPercent)!;

            // Mirror: window.resetAt.map { Date(timeIntervalSince1970: $0 / 1000) }
            DateTimeOffset? resetAt = window.ResetAt.HasValue
                ? DateTimeOffset.FromUnixTimeMilliseconds((long)window.ResetAt.Value)
                : null;

            rows.Add(new UsageRow(
                Id: $"{provider.Provider}-{window.Label}",
                ProviderId: provider.Provider,
                DisplayName: provider.DisplayName,
                Plan: provider.Plan,
                WindowLabel: window.Label,
                UsedPercent: window.UsedPercent,
                ResetAt: resetAt,
                Error: null));
        }
        return rows;
    }
}

public sealed record UsageRow(
    string Id,
    string ProviderId,
    string DisplayName,
    string? Plan,
    string? WindowLabel,
    double? UsedPercent,
    DateTimeOffset? ResetAt,
    string? Error)
{
    public bool HasError => !string.IsNullOrEmpty(Error);

    // "{displayName} ({plan})" or just displayName.
    public string TitleText =>
        !string.IsNullOrEmpty(Plan) ? $"{DisplayName} ({Plan})" : DisplayName;

    // max(0, min(100, round(100 - usedPercent))).
    // Returns null if usedPercent is absent or not finite.
    public int? RemainingPercent
    {
        get
        {
            if (UsedPercent is not { } pct || !double.IsFinite(pct)) return null;
            return Math.Max(0, Math.Min(100, (int)Math.Round(100 - pct)));
        }
    }

    // builds "N% left · label · ⏱reset" string.
    public string DetailText(DateTimeOffset? now = null)
    {
        if (RemainingPercent is not { } remaining) return "No data";

        var parts = new List<string>(3) { $"{remaining}% left" };

        if (!string.IsNullOrEmpty(WindowLabel))
            parts.Add(WindowLabel);

        if (ResetAt.HasValue)
        {
            var reset = FormatResetRemaining(ResetAt.Value, now ?? DateTimeOffset.UtcNow);
            if (reset is not null) parts.Add($"⏱{reset}");
        }

        return string.Join(" · ", parts);
    }

    // Returns null when diff ≤ 0 ("now" is returned by the caller branch — kept here
    // to match Swift: the private helper returns "now" for diff ≤ 0).
    private static string? FormatResetRemaining(DateTimeOffset target, DateTimeOffset now)
    {
        var diff = (target - now).TotalSeconds;
        if (diff <= 0) return "now";

        var minutes = (int)Math.Floor(diff / 60);
        if (minutes < 60) return $"{minutes}m";

        var hours = minutes / 60;
        var mins  = minutes % 60;
        if (hours < 24) return mins > 0 ? $"{hours}h {mins}m" : $"{hours}h";

        var days = hours / 24;
        if (days < 7) return $"{days}d {hours % 24}h";

        // Mirror: DateFormatter with dateFormat "MMM d"
        return target.ToString("MMM d", CultureInfo.InvariantCulture);
    }
}
