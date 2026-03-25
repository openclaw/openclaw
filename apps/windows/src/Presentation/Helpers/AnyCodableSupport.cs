using System.Text.Json;

namespace OpenClawWindows.Presentation.Helpers;

// Windows uses JsonElement (System.Text.Json) as the AnyCodable equivalent.
internal static class AnyCodableSupport
{
    internal static string? StringValue(this JsonElement el) =>
        el.ValueKind == JsonValueKind.String ? el.GetString() : null;

    internal static bool? BoolValue(this JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };

    internal static int? IntValue(this JsonElement el) =>
        el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var v) ? v : null;

    internal static double? DoubleValue(this JsonElement el) =>
        el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var d) ? d : null;

    internal static IReadOnlyDictionary<string, JsonElement>? DictionaryValue(this JsonElement el)
    {
        if (el.ValueKind != JsonValueKind.Object) return null;
        var dict = new Dictionary<string, JsonElement>();
        foreach (var prop in el.EnumerateObject())
            dict[prop.Name] = prop.Value;
        return dict;
    }

    internal static IReadOnlyList<JsonElement>? ArrayValue(this JsonElement el)
    {
        if (el.ValueKind != JsonValueKind.Array) return null;
        var list = new List<JsonElement>();
        foreach (var item in el.EnumerateArray())
            list.Add(item);
        return list;
    }

    // recursively unwraps to plain .NET types.
    // Object → Dictionary<string, object?>, Array → List<object?>, primitives → boxed value.
    internal static object? FoundationValue(this JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Object => el.EnumerateObject()
            .ToDictionary(p => p.Name, p => p.Value.FoundationValue()),
        JsonValueKind.Array => el.EnumerateArray()
            .Select(v => v.FoundationValue())
            .ToList(),
        JsonValueKind.String => el.GetString(),
        JsonValueKind.True => (object)true,
        JsonValueKind.False => false,
        JsonValueKind.Number when el.TryGetInt64(out var l) => l,
        JsonValueKind.Number => el.GetDouble(),
        _ => null,
    };
}
