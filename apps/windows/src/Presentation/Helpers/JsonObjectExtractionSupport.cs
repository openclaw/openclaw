using System.Text.Json;

namespace OpenClawWindows.Presentation.Helpers;

internal static class JsonObjectExtractionSupport
{
    internal static (string Text, IReadOnlyDictionary<string, JsonElement> Object)? Extract(string raw)
    {
        var trimmed = raw.Trim();
        var start = trimmed.IndexOf('{');
        var end = trimmed.LastIndexOf('}');
        if (start < 0 || end < start)
            return null;

        var jsonText = trimmed[start..(end + 1)];
        try
        {
            using var doc = JsonDocument.Parse(jsonText);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
                return null;

            // Clone detaches elements from JsonDocument lifetime.
            var root = doc.RootElement.Clone();
            var dict = new Dictionary<string, JsonElement>();
            foreach (var prop in root.EnumerateObject())
                dict[prop.Name] = prop.Value;
            return (jsonText, dict);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
