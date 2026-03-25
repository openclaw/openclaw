using System.Text.Json;

namespace OpenClawWindows.Application.Onboarding;

public sealed record WizardStepDto(
    string Id,
    string Type,        // "note" | "text" | "confirm" | "select" | "multiselect" | "progress" | "action"
    string? Title,
    string? Message,
    IReadOnlyList<WizardOptionDto> Options,
    string InitialValueString,   // empty when not a text step
    bool   InitialValueBool,     // false when not a confirm step
    string? Placeholder,
    bool Sensitive);

public sealed record WizardOptionDto(string Label, string? Hint, JsonElement? Value);

public sealed record WizardStartRpcResult(
    string   SessionId,
    bool     Done,
    WizardStepDto? Step,
    string?  Status,
    string?  Error);

public sealed record WizardNextRpcResult(
    bool     Done,
    WizardStepDto? Step,
    string?  Status,
    string?  Error);

// ── Parsing helpers ─────────────────────────────

internal static class WizardDtoHelpers
{
    // extracts string from AnyCodable type field.
    internal static string StepType(JsonElement typeEl)
        => typeEl.ValueKind == JsonValueKind.String
            ? typeEl.GetString() ?? ""
            : "";

    internal static string? StatusString(JsonElement? el)
    {
        if (el is null || el.Value.ValueKind == JsonValueKind.Null) return null;
        var s = el.Value.ValueKind == JsonValueKind.String
            ? el.Value.GetString()?.Trim().ToLowerInvariant()
            : null;
        return string.IsNullOrEmpty(s) ? null : s;
    }

    internal static string AnyCodableString(JsonElement el)
        => el.ValueKind switch
        {
            JsonValueKind.String => el.GetString() ?? "",
            JsonValueKind.Number => el.GetRawText(),
            JsonValueKind.True   => "true",
            JsonValueKind.False  => "false",
            _                    => "",
        };

    internal static bool AnyCodableBool(JsonElement el)
        => el.ValueKind switch
        {
            JsonValueKind.True   => true,
            JsonValueKind.False  => false,
            JsonValueKind.Number => el.GetDouble() != 0,
            JsonValueKind.String => el.GetString()?.Trim().ToLowerInvariant() is "true" or "1" or "yes",
            _                    => false,
        };

    internal static IReadOnlyList<WizardOptionDto> ParseOptions(JsonElement? optionsEl)
    {
        if (optionsEl is null || optionsEl.Value.ValueKind != JsonValueKind.Array)
            return Array.Empty<WizardOptionDto>();

        var result = new List<WizardOptionDto>();
        foreach (var item in optionsEl.Value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var label = item.TryGetProperty("label", out var lEl) ? lEl.GetString() ?? "" : "";
            var hint  = item.TryGetProperty("hint",  out var hEl) && hEl.ValueKind == JsonValueKind.String
                ? hEl.GetString() : null;
            var value = item.TryGetProperty("value", out var vEl) ? (JsonElement?)vEl.Clone() : null;
            result.Add(new WizardOptionDto(label, hint, value));
        }
        return result;
    }

    // tolerates missing/null fields.
    internal static WizardStepDto? DecodeStep(JsonElement? raw)
    {
        if (raw is null || raw.Value.ValueKind == JsonValueKind.Null) return null;

        try
        {
            var el = raw.Value;
            var id   = el.TryGetProperty("id",   out var idEl)   ? idEl.GetString()  ?? "" : "";
            var type = el.TryGetProperty("type", out var typeEl)  ? StepType(typeEl)   : "";

            var initVal = el.TryGetProperty("initialValue", out var ivEl) ? ivEl : default;
            var initStr = initVal.ValueKind != JsonValueKind.Undefined ? AnyCodableString(initVal) : "";
            var initBl  = initVal.ValueKind != JsonValueKind.Undefined ? AnyCodableBool(initVal)   : false;

            var opts = el.TryGetProperty("options", out var optsEl)
                ? ParseOptions(optsEl)
                : Array.Empty<WizardOptionDto>();

            var title = el.TryGetProperty("title",       out var tEl) ? tEl.GetString() : null;
            var msg   = el.TryGetProperty("message",     out var mEl) ? mEl.GetString() : null;
            var ph    = el.TryGetProperty("placeholder", out var phEl) ? phEl.GetString() : null;
            var sens  = el.TryGetProperty("sensitive",   out var sEl) && sEl.ValueKind == JsonValueKind.True;

            return new WizardStepDto(id, type, title, msg, opts, initStr, initBl, ph, sens);
        }
        catch
        {
            return null;
        }
    }
}
