using System.Text.Json;

namespace OpenClawWindows.Infrastructure.Config;

internal abstract record ConfigPathSegment
{
    internal sealed record Key(string Value) : ConfigPathSegment;
    internal sealed record Index(int Value) : ConfigPathSegment;
}

internal sealed class ConfigUiHint
{
    internal string? Label { get; }
    internal string? Help { get; }
    internal double? Order { get; }
    internal bool? Advanced { get; }
    internal bool? Sensitive { get; }
    internal string? Placeholder { get; }

    internal ConfigUiHint(JsonElement raw)
    {
        Label = TryGetString(raw, "label");
        Help = TryGetString(raw, "help");
        Order = TryGetOrder(raw);
        Advanced = TryGetBool(raw, "advanced");
        Sensitive = TryGetBool(raw, "sensitive");
        Placeholder = TryGetString(raw, "placeholder");
    }

    private static string? TryGetString(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool? TryGetBool(JsonElement obj, string key)
    {
        if (!obj.TryGetProperty(key, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.True  => true,
            JsonValueKind.False => false,
            _                   => null,
        };
    }

    private static double? TryGetOrder(JsonElement obj)
    {
        if (!obj.TryGetProperty("order", out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number)
        {
            if (v.TryGetDouble(out var d)) return d;
            if (v.TryGetInt32(out var i)) return (double)i;
        }
        return null;
    }
}

internal sealed class ConfigSchemaNode
{
    private readonly JsonElement _raw;

    private ConfigSchemaNode(JsonElement raw) => _raw = raw;

    internal static ConfigSchemaNode? Create(JsonElement raw) =>
        raw.ValueKind == JsonValueKind.Object ? new ConfigSchemaNode(raw) : null;

    internal string? Title => TryGetString("title");
    internal string? Description => TryGetString("description");

    internal JsonElement? EnumValues =>
        _raw.TryGetProperty("enum", out var v) && v.ValueKind == JsonValueKind.Array ? v : null;

    internal JsonElement? ConstValue =>
        _raw.TryGetProperty("const", out var v) ? v : null;

    internal JsonElement? ExplicitDefault =>
        _raw.TryGetProperty("default", out var v) ? v : null;

    internal HashSet<string> RequiredKeys
    {
        get
        {
            if (!_raw.TryGetProperty("required", out var v) || v.ValueKind != JsonValueKind.Array)
                return [];
            return [.. v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!)];
        }
    }

    internal IReadOnlyList<string> TypeList
    {
        get
        {
            if (!_raw.TryGetProperty("type", out var v)) return [];
            if (v.ValueKind == JsonValueKind.String) return [v.GetString()!];
            if (v.ValueKind == JsonValueKind.Array)
                return [.. v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!)];
            return [];
        }
    }

    internal string? SchemaType
    {
        get
        {
            var types = TypeList;
            var nonNull = types.FirstOrDefault(t => t != "null");
            return nonNull ?? types.FirstOrDefault();
        }
    }

    internal bool IsNullSchema
    {
        get
        {
            var types = TypeList;
            return types.Count == 1 && types[0] == "null";
        }
    }

    internal IReadOnlyDictionary<string, ConfigSchemaNode> Properties
    {
        get
        {
            if (!_raw.TryGetProperty("properties", out var v) || v.ValueKind != JsonValueKind.Object)
                return new Dictionary<string, ConfigSchemaNode>();
            var result = new Dictionary<string, ConfigSchemaNode>();
            foreach (var prop in v.EnumerateObject())
            {
                var node = Create(prop.Value);
                if (node is not null)
                    result[prop.Name] = node;
            }
            return result;
        }
    }

    internal IReadOnlyList<ConfigSchemaNode> AnyOf => GetSchemaArray("anyOf");
    internal IReadOnlyList<ConfigSchemaNode> OneOf => GetSchemaArray("oneOf");

    internal JsonElement? LiteralValue
    {
        get
        {
            if (ConstValue is { } cv) return cv;
            var enums = EnumValues;
            if (enums is not null && enums.Value.GetArrayLength() == 1)
                return enums.Value.EnumerateArray().First();
            return null;
        }
    }

    internal ConfigSchemaNode? Items
    {
        get
        {
            if (!_raw.TryGetProperty("items", out var v)) return null;
            if (v.ValueKind == JsonValueKind.Array)
            {
                var first = v.EnumerateArray().FirstOrDefault();
                return first.ValueKind != JsonValueKind.Undefined ? Create(first) : null;
            }
            return Create(v);
        }
    }

    internal ConfigSchemaNode? AdditionalProperties
    {
        get
        {
            if (!_raw.TryGetProperty("additionalProperties", out var v)) return null;
            return v.ValueKind == JsonValueKind.Object ? Create(v) : null;
        }
    }

    internal bool AllowsAdditionalProperties
    {
        get
        {
            if (!_raw.TryGetProperty("additionalProperties", out var v)) return false;
            if (v.ValueKind == JsonValueKind.True) return true;
            if (v.ValueKind == JsonValueKind.False) return false;
            return AdditionalProperties is not null;
        }
    }

    internal object DefaultValue
    {
        get
        {
            if (_raw.TryGetProperty("default", out var v)) return (object)v;
            return SchemaType switch
            {
                "object"  => new Dictionary<string, object>(),
                "array"   => new List<object>(),
                "boolean" => (object)false,
                "integer" => (object)0,
                "number"  => (object)0.0,
                _         => string.Empty,
            };
        }
    }

    internal ConfigSchemaNode? NodeAt(IReadOnlyList<ConfigPathSegment> path)
    {
        ConfigSchemaNode? current = this;
        foreach (var segment in path)
        {
            if (current is null) return null;
            switch (segment)
            {
                case ConfigPathSegment.Key k:
                    if (current.SchemaType != "object") return null;
                    if (current.Properties.TryGetValue(k.Value, out var next))
                    {
                        current = next;
                        continue;
                    }
                    if (current.AdditionalProperties is { } additional)
                    {
                        current = additional;
                        continue;
                    }
                    return null;

                case ConfigPathSegment.Index:
                    if (current.SchemaType != "array") return null;
                    current = current.Items;
                    break;
            }
        }
        return current;
    }

    private string? TryGetString(string key) =>
        _raw.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private IReadOnlyList<ConfigSchemaNode> GetSchemaArray(string key)
    {
        if (!_raw.TryGetProperty(key, out var v) || v.ValueKind != JsonValueKind.Array)
            return [];
        return [.. v.EnumerateArray().Select(Create).Where(n => n is not null)!];
    }
}

internal static class ConfigSchemaFunctions
{
    internal static Dictionary<string, ConfigUiHint> DecodeUiHints(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Object)
            return [];
        var result = new Dictionary<string, ConfigUiHint>();
        foreach (var prop in raw.EnumerateObject())
        {
            if (prop.Value.ValueKind == JsonValueKind.Object)
                result[prop.Name] = new ConfigUiHint(prop.Value);
        }
        return result;
    }

    internal static ConfigUiHint? HintForPath(IReadOnlyList<ConfigPathSegment> path, Dictionary<string, ConfigUiHint> hints)
    {
        var key = PathKey(path);
        if (hints.TryGetValue(key, out var direct)) return direct;

        var segments = key.Split('.');
        foreach (var (hintKey, hint) in hints)
        {
            if (!hintKey.Contains('*')) continue;
            var hintSegments = hintKey.Split('.');
            if (hintSegments.Length != segments.Length) continue;
            var match = true;
            for (var i = 0; i < segments.Length; i++)
            {
                if (hintSegments[i] != "*" && hintSegments[i] != segments[i])
                {
                    match = false;
                    break;
                }
            }
            if (match) return hint;
        }
        return null;
    }

    internal static bool IsSensitivePath(IReadOnlyList<ConfigPathSegment> path)
    {
        var key = PathKey(path).ToLowerInvariant();
        return key.Contains("token")
            || key.Contains("password")
            || key.Contains("secret")
            || key.Contains("apikey")
            || key.EndsWith("key", StringComparison.Ordinal);
    }

    internal static string PathKey(IReadOnlyList<ConfigPathSegment> path) =>
        string.Join(".", path
            .OfType<ConfigPathSegment.Key>()
            .Select(k => k.Value));
}
