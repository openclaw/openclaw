// Mirrors GatewayModels.swift + WizardHelpers.swift:
// wire-protocol types and AnyCodable helper functions.
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace OpenClawWindows.CLI;

// Matches GATEWAY_PROTOCOL_VERSION in GatewayModels.swift.
internal static class GatewayProtocol
{
    internal const int Version = 3;
}

// ── Request / Response / Event frames ─────────────────────────────────────────

internal sealed record RequestFrame(
    [property: JsonPropertyName("type")]   string   Type,
    [property: JsonPropertyName("id")]     string   Id,
    [property: JsonPropertyName("method")] string   Method,
    [property: JsonPropertyName("params")] JsonNode? Params);

internal sealed record ResponseFrame(
    [property: JsonPropertyName("type")]    string   Type,
    [property: JsonPropertyName("id")]      string   Id,
    [property: JsonPropertyName("ok")]      bool     Ok,
    [property: JsonPropertyName("payload")] JsonNode? Payload,
    [property: JsonPropertyName("error")]   JsonNode? Error);

internal sealed record EventFrame(
    [property: JsonPropertyName("type")]    string   Type,
    [property: JsonPropertyName("event")]   string   Event,
    [property: JsonPropertyName("payload")] JsonNode? Payload);

// Mirrors GatewayFrame enum in GatewayModels.swift — discriminated on "type" field.
[JsonConverter(typeof(GatewayFrameConverter))]
internal abstract record GatewayFrame
{
    internal sealed record Req(RequestFrame  Frame) : GatewayFrame;
    internal sealed record Res(ResponseFrame Frame) : GatewayFrame;
    internal sealed record Evt(EventFrame    Frame) : GatewayFrame;
    internal sealed record Unknown(string    FrameType) : GatewayFrame;
}

internal sealed class GatewayFrameConverter : JsonConverter<GatewayFrame>
{
    public override GatewayFrame? Read(
        ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;
        var raw  = root.GetRawText();

        if (!root.TryGetProperty("type", out var typeProp))
            return new GatewayFrame.Unknown("unknown");

        return typeProp.GetString() switch
        {
            "req"   => new GatewayFrame.Req(JsonSerializer.Deserialize<RequestFrame>(raw,  options)!),
            "res"   => new GatewayFrame.Res(JsonSerializer.Deserialize<ResponseFrame>(raw, options)!),
            "event" => new GatewayFrame.Evt(JsonSerializer.Deserialize<EventFrame>(raw,    options)!),
            var t   => new GatewayFrame.Unknown(t ?? "unknown"),
        };
    }

    public override void Write(
        Utf8JsonWriter writer, GatewayFrame value, JsonSerializerOptions options)
        => throw new NotSupportedException(); // CLI only decodes GatewayFrame, never encodes
}

// ── Application types ──────────────────────────────────────────────────────────

// Mirrors HelloOk struct in GatewayModels.swift.
internal sealed record HelloOk(
    [property: JsonPropertyName("type")]         string    Type,
    [property: JsonPropertyName("protocol")]     int       Protocol,
    [property: JsonPropertyName("server")]       JsonNode? Server,
    [property: JsonPropertyName("features")]     JsonNode? Features,
    [property: JsonPropertyName("snapshot")]     JsonNode? Snapshot,
    [property: JsonPropertyName("canvasHostUrl")] string?  CanvasHostUrl,
    [property: JsonPropertyName("auth")]         JsonNode? Auth,
    [property: JsonPropertyName("policy")]       JsonNode? Policy);

// Mirrors WizardStep struct in GatewayModels.swift.
internal sealed record WizardStep(
    [property: JsonPropertyName("id")]           string    Id,
    [property: JsonPropertyName("type")]         JsonNode? Type,
    [property: JsonPropertyName("title")]        string?   Title,
    [property: JsonPropertyName("message")]      string?   Message,
    [property: JsonPropertyName("options")]      JsonArray? Options,
    [property: JsonPropertyName("initialValue")] JsonNode? InitialValue,
    [property: JsonPropertyName("placeholder")]  string?   Placeholder,
    [property: JsonPropertyName("sensitive")]    bool?     Sensitive,
    [property: JsonPropertyName("executor")]     JsonNode? Executor);

// Mirrors WizardStartResult struct in GatewayModels.swift.
internal sealed record WizardStartResult(
    [property: JsonPropertyName("sessionId")] string    SessionId,
    [property: JsonPropertyName("done")]      bool      Done,
    [property: JsonPropertyName("step")]      JsonNode? Step,
    [property: JsonPropertyName("status")]    JsonNode? Status,
    [property: JsonPropertyName("error")]     string?   Error);

// Mirrors WizardNextResult struct in GatewayModels.swift.
internal sealed record WizardNextResult(
    [property: JsonPropertyName("done")]   bool      Done,
    [property: JsonPropertyName("step")]   JsonNode? Step,
    [property: JsonPropertyName("status")] JsonNode? Status,
    [property: JsonPropertyName("error")]  string?   Error);

// Mirrors WizardOption struct in WizardHelpers.swift.
internal sealed record WizardOption(JsonNode? Value, string Label, string? Hint);

// ── AnyCodable helper functions (mirrors WizardHelpers.swift) ─────────────────

internal static class WizardHelpers
{
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    // Mirrors wizardStepType().
    internal static string WizardStepType(WizardStep step)
        => step.Type?.GetValue<string>() ?? "";

    // Mirrors wizardStatusString().
    internal static string? WizardStatusString(JsonNode? value)
    {
        var s = value?.GetValue<string>()?.Trim().ToLowerInvariant();
        return string.IsNullOrEmpty(s) ? null : s;
    }

    // Mirrors decodeWizardStep().
    internal static WizardStep? DecodeWizardStep(JsonNode? raw)
    {
        if (raw == null) return null;
        try   { return raw.Deserialize<WizardStep>(JsonOptions); }
        catch { return null; }
    }

    // Mirrors parseWizardOptions().
    internal static List<WizardOption> ParseWizardOptions(JsonArray? raw)
    {
        if (raw == null) return [];
        var result = new List<WizardOption>();
        foreach (var item in raw)
        {
            if (item is not JsonObject obj) continue;
            result.Add(new WizardOption(
                Value: obj["value"],
                Label: obj["label"]?.GetValue<string>() ?? "",
                Hint:  obj["hint"]?.GetValue<string>()));
        }
        return result;
    }

    // Mirrors anyCodableString().
    internal static string AnyCodableString(JsonNode? value)
        => value?.GetValueKind() switch
        {
            JsonValueKind.String => value.GetValue<string>(),
            JsonValueKind.Number => value.ToString()!,
            JsonValueKind.True   => "true",
            JsonValueKind.False  => "false",
            _                    => "",
        } ?? "";

    // Mirrors anyCodableBool().
    internal static bool AnyCodableBool(JsonNode? value)
        => value?.GetValueKind() switch
        {
            JsonValueKind.True   => true,
            JsonValueKind.False  => false,
            JsonValueKind.Number => value.GetValue<double>() != 0,
            JsonValueKind.String => value.GetValue<string>().Trim().ToLowerInvariant()
                                        is "true" or "1" or "yes",
            _ => false,
        };

    // Mirrors anyCodableArray().
    internal static List<JsonNode> AnyCodableArray(JsonNode? value)
        => value is JsonArray arr
            ? arr.Where(x => x != null).Select(x => x!).ToList()
            : [];

    // Mirrors anyCodableEqual() — converts both sides to string for cross-type comparison.
    internal static bool AnyCodableEqual(JsonNode? lhs, JsonNode? rhs)
    {
        if (lhs == null && rhs == null) return true;
        if (lhs == null || rhs == null) return false;
        return AnyCodableString(lhs) == AnyCodableString(rhs);
    }
}

// ── Networking helpers ─────────────────────────────────────────────────────────

internal static class NetworkHelpers
{
    // Mirrors resolveLocalHost() in ConnectCommand.swift: "tailnet" → Tailscale CGNAT IP.
    internal static string ResolveLocalHost(string? bind)
    {
        var normalized = (bind ?? "").Trim().ToLowerInvariant();
        if (normalized == "tailnet")
        {
            var tailnetIp = DetectTailnetIPv4();
            if (tailnetIp != null) return tailnetIp;
        }
        return "127.0.0.1";
    }

    // Detect Tailscale CGNAT IPv4 (100.64.0.0/10 range) from local interfaces.
    private static string? DetectTailnetIPv4()
    {
        try
        {
            foreach (var iface in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (iface.OperationalStatus != OperationalStatus.Up) continue;
                foreach (var addr in iface.GetIPProperties().UnicastAddresses)
                {
                    if (addr.Address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
                        continue;
                    var bytes = addr.Address.GetAddressBytes();
                    // 100.64.0.0/10 covers 100.64.x.x through 100.127.x.x
                    if (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127)
                        return addr.Address.ToString();
                }
            }
        }
        catch { /* non-fatal */ }
        return null;
    }

    // Check if a given IP belongs to the local machine (for isLocal in discover).
    internal static bool IsLocalIp(string ip)
    {
        try
        {
            var target = System.Net.IPAddress.Parse(ip);
            foreach (var iface in NetworkInterface.GetAllNetworkInterfaces())
            {
                foreach (var addr in iface.GetIPProperties().UnicastAddresses)
                {
                    if (addr.Address.Equals(target)) return true;
                }
            }
        }
        catch { /* non-fatal */ }
        return false;
    }
}
