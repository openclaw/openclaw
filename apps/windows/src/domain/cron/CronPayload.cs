using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Cron;

[JsonConverter(typeof(CronSessionTargetConverter))]
public enum CronSessionTarget { Main, Isolated }

[JsonConverter(typeof(CronWakeModeConverter))]
public enum CronWakeMode { Now, NextHeartbeat }

[JsonConverter(typeof(CronDeliveryModeConverter))]
public enum CronDeliveryMode { None, Announce, Webhook }

public sealed class CronDelivery
{
    [JsonPropertyName("mode")]        public CronDeliveryMode Mode { get; init; }
    [JsonPropertyName("channel")]     public string? Channel { get; init; }
    [JsonPropertyName("to")]          public string? To { get; init; }
    [JsonPropertyName("bestEffort")]  public bool? BestEffort { get; init; }
}

/// <summary>
/// Discriminated union representing a cron job payload.
/// </summary>
[JsonConverter(typeof(CronPayloadJsonConverter))]
public abstract record CronPayload
{
    private protected CronPayload() { }

    public sealed record SystemEvent(string Text) : CronPayload;

    public sealed record AgentTurn(
        string Message,
        string? Thinking,
        int? TimeoutSeconds,
        bool? Deliver,
        string? Channel,
        string? To,
        bool? BestEffortDeliver) : CronPayload;
}

internal sealed class CronPayloadJsonConverter : JsonConverter<CronPayload>
{
    public override CronPayload Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;

        var kind = root.GetProperty("kind").GetString()
            ?? throw new JsonException("Missing payload.kind");

        return kind switch
        {
            "systemEvent" => new CronPayload.SystemEvent(
                root.GetProperty("text").GetString() ?? string.Empty),

            "agentTurn" => ReadAgentTurn(root),

            _ => throw new JsonException($"Unknown payload kind: {kind}")
        };
    }

    private static CronPayload.AgentTurn ReadAgentTurn(JsonElement root)
    {
        var message = root.GetProperty("message").GetString() ?? string.Empty;
        string? thinking = GetOptionalString(root, "thinking");
        int? timeoutSeconds = root.TryGetProperty("timeoutSeconds", out var to) && to.ValueKind != JsonValueKind.Null
            ? to.GetInt32() : null;
        bool? deliver = root.TryGetProperty("deliver", out var d) && d.ValueKind != JsonValueKind.Null
            ? d.GetBoolean() : null;

        string? channel = GetOptionalString(root, "channel") ?? GetOptionalString(root, "provider");

        string? toField = GetOptionalString(root, "to");
        bool? bestEffortDeliver = root.TryGetProperty("bestEffortDeliver", out var bed) && bed.ValueKind != JsonValueKind.Null
            ? bed.GetBoolean() : null;

        return new CronPayload.AgentTurn(message, thinking, timeoutSeconds, deliver, channel, toField, bestEffortDeliver);
    }

    private static string? GetOptionalString(JsonElement root, string key) =>
        root.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString() : null;

    public override void Write(Utf8JsonWriter writer, CronPayload value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        switch (value)
        {
            case CronPayload.SystemEvent se:
                writer.WriteString("kind", "systemEvent");
                writer.WriteString("text", se.Text);
                break;

            case CronPayload.AgentTurn at:
                writer.WriteString("kind", "agentTurn");
                writer.WriteString("message", at.Message);
                WriteOptionalString(writer, "thinking", at.Thinking);
                if (at.TimeoutSeconds.HasValue) writer.WriteNumber("timeoutSeconds", at.TimeoutSeconds.Value);
                if (at.Deliver.HasValue) writer.WriteBoolean("deliver", at.Deliver.Value);
                WriteOptionalString(writer, "channel", at.Channel);
                WriteOptionalString(writer, "to", at.To);
                if (at.BestEffortDeliver.HasValue) writer.WriteBoolean("bestEffortDeliver", at.BestEffortDeliver.Value);
                break;
        }
        writer.WriteEndObject();
    }

    private static void WriteOptionalString(Utf8JsonWriter w, string key, string? value)
    {
        if (value is not null) w.WriteString(key, value);
    }
}

// ── Enum converters ────────────────────────────────────────────────────────────

internal sealed class CronSessionTargetConverter : JsonConverter<CronSessionTarget>
{
    public override CronSessionTarget Read(ref Utf8JsonReader r, Type t, JsonSerializerOptions o) =>
        r.GetString() switch
        {
            "main"     => CronSessionTarget.Main,
            "isolated" => CronSessionTarget.Isolated,
            var s      => throw new JsonException($"Unknown sessionTarget: {s}")
        };

    public override void Write(Utf8JsonWriter w, CronSessionTarget v, JsonSerializerOptions o) =>
        w.WriteStringValue(v switch
        {
            CronSessionTarget.Main     => "main",
            CronSessionTarget.Isolated => "isolated",
            _                          => throw new JsonException($"Unknown CronSessionTarget: {v}")
        });
}

internal sealed class CronWakeModeConverter : JsonConverter<CronWakeMode>
{
    public override CronWakeMode Read(ref Utf8JsonReader r, Type t, JsonSerializerOptions o) =>
        r.GetString() switch
        {
            "now"            => CronWakeMode.Now,
            "next-heartbeat" => CronWakeMode.NextHeartbeat,
            var s            => throw new JsonException($"Unknown wakeMode: {s}")
        };

    public override void Write(Utf8JsonWriter w, CronWakeMode v, JsonSerializerOptions o) =>
        w.WriteStringValue(v switch
        {
            CronWakeMode.Now           => "now",
            CronWakeMode.NextHeartbeat => "next-heartbeat",
            _                          => throw new JsonException($"Unknown CronWakeMode: {v}")
        });
}

internal sealed class CronDeliveryModeConverter : JsonConverter<CronDeliveryMode>
{
    public override CronDeliveryMode Read(ref Utf8JsonReader r, Type t, JsonSerializerOptions o) =>
        r.GetString() switch
        {
            "none"     => CronDeliveryMode.None,
            "announce" => CronDeliveryMode.Announce,
            "webhook"  => CronDeliveryMode.Webhook,
            var s      => throw new JsonException($"Unknown deliveryMode: {s}")
        };

    public override void Write(Utf8JsonWriter w, CronDeliveryMode v, JsonSerializerOptions o) =>
        w.WriteStringValue(v switch
        {
            CronDeliveryMode.None     => "none",
            CronDeliveryMode.Announce => "announce",
            CronDeliveryMode.Webhook  => "webhook",
            _                         => throw new JsonException($"Unknown CronDeliveryMode: {v}")
        });
}
