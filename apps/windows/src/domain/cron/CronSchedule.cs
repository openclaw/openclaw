using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Cron;

/// <summary>
/// Discriminated union representing a cron job schedule.
/// </summary>
[JsonConverter(typeof(CronScheduleJsonConverter))]
public abstract record CronSchedule
{
    // Closed hierarchy — only the nested types below are valid.
    private protected CronSchedule() { }

    // absolute ISO-8601 datetime string.
    public sealed record At(string AtValue) : CronSchedule;

    // recurring interval in milliseconds.
    public sealed record Every(int EveryMs, int? AnchorMs) : CronSchedule;

    // cron expression with optional IANA timezone.
    public sealed record CronExpr(string Expr, string? Tz) : CronSchedule;

    // tries with and without fractional seconds.
    public static DateTimeOffset? ParseAtDate(string value)
    {
        var trimmed = value.Trim();
        if (trimmed.Length == 0) return null;
        if (DateTimeOffset.TryParse(trimmed, CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind, out var result))
            return result;
        return null;
    }

    // RFC3339 without fractional seconds, always UTC Z.
    public static string FormatIsoDate(DateTimeOffset date) =>
        date.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
}

internal sealed class CronScheduleJsonConverter : JsonConverter<CronSchedule>
{
    public override CronSchedule Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;

        var kind = root.GetProperty("kind").GetString()
            ?? throw new JsonException("Missing schedule.kind");

        return kind switch
        {
            "at"    => ReadAt(root),
            "every" => ReadEvery(root),
            "cron"  => ReadCron(root),
            _       => throw new JsonException($"Unknown schedule kind: {kind}")
        };
    }

    private static CronSchedule.At ReadAt(JsonElement root)
    {
        // Try string "at" field first.
        if (root.TryGetProperty("at", out var atProp) && atProp.ValueKind == JsonValueKind.String)
        {
            var at = atProp.GetString() ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(at))
                return new CronSchedule.At(at);
        }

        // Legacy fallback: "atMs" epoch-ms → ISO string.
        if (root.TryGetProperty("atMs", out var atMsProp) && atMsProp.TryGetInt64(out var atMs))
        {
            var date = DateTimeOffset.FromUnixTimeMilliseconds(atMs);
            return new CronSchedule.At(CronSchedule.FormatIsoDate(date));
        }

        throw new JsonException("Missing schedule.at");
    }

    private static CronSchedule.Every ReadEvery(JsonElement root)
    {
        var everyMs = root.GetProperty("everyMs").GetInt32();
        int? anchorMs = root.TryGetProperty("anchorMs", out var a) && a.ValueKind != JsonValueKind.Null
            ? a.GetInt32() : null;
        return new CronSchedule.Every(everyMs, anchorMs);
    }

    private static CronSchedule.CronExpr ReadCron(JsonElement root)
    {
        var expr = root.GetProperty("expr").GetString() ?? string.Empty;
        string? tz = root.TryGetProperty("tz", out var t) && t.ValueKind == JsonValueKind.String
            ? t.GetString() : null;
        return new CronSchedule.CronExpr(expr, tz);
    }

    public override void Write(Utf8JsonWriter writer, CronSchedule value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        switch (value)
        {
            case CronSchedule.At at:
                writer.WriteString("kind", "at");
                writer.WriteString("at", at.AtValue);
                break;
            case CronSchedule.Every every:
                writer.WriteString("kind", "every");
                writer.WriteNumber("everyMs", every.EveryMs);
                if (every.AnchorMs.HasValue)
                    writer.WriteNumber("anchorMs", every.AnchorMs.Value);
                break;
            case CronSchedule.CronExpr cron:
                writer.WriteString("kind", "cron");
                writer.WriteString("expr", cron.Expr);
                if (cron.Tz is not null)
                    writer.WriteString("tz", cron.Tz);
                break;
        }
        writer.WriteEndObject();
    }
}
