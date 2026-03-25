using System.Reflection;
using System.Text.Json;

namespace OpenClawWindows.Infrastructure.Devices;

internal sealed record DevicePresentation(string Title, string? Symbol);

/// <summary>
/// Resolves device-family/model-identifier pairs to a human-readable title and
/// a symbol name for UI display, using embedded JSON resources.
/// </summary>
internal static class DeviceModelCatalog
{
    private static readonly Dictionary<string, string> _modelIdentifierToName = LoadModelIdentifierToName();
    private const string ResourceSubdirectory = "DeviceModels";

    internal static DevicePresentation? Presentation(string? deviceFamily, string? modelIdentifier)
    {
        var family = (deviceFamily ?? string.Empty).Trim();
        var model = (modelIdentifier ?? string.Empty).Trim();

        var friendlyName = model.Length == 0 ? null
            : _modelIdentifierToName.TryGetValue(model, out var n) ? n : null;

        var symbol = Symbol(family, model, friendlyName);

        var title = (!string.IsNullOrEmpty(friendlyName))   ? friendlyName
            : (!string.IsNullOrEmpty(family) && !string.IsNullOrEmpty(model)) ? $"{family} ({model})"
            : !string.IsNullOrEmpty(family)                                    ? family
            : !string.IsNullOrEmpty(model)                                     ? model
            :                                                                    string.Empty;

        if (title.Length == 0) return null;
        return new DevicePresentation(title, symbol);
    }

    internal static string? Symbol(string deviceFamily, string modelIdentifier, string? friendlyName)
    {
        var family = deviceFamily.Trim();
        var model = modelIdentifier.Trim();
        return SymbolFor(model, friendlyName) ?? FallbackSymbol(family, model);
    }

    private static string? SymbolFor(string rawModelIdentifier, string? friendlyName)
    {
        var model = rawModelIdentifier.Trim();
        if (model.Length == 0) return null;

        var lower = model.ToLowerInvariant();

        if (lower.StartsWith("ipad"))    return "ipad";
        if (lower.StartsWith("iphone"))  return "iphone";
        if (lower.StartsWith("ipod"))    return "iphone";
        if (lower.StartsWith("watch"))   return "applewatch";
        if (lower.StartsWith("appletv")) return "appletv";
        if (lower.StartsWith("audio") || lower.StartsWith("homepod")) return "speaker";

        if (lower.StartsWith("macbook") || lower.StartsWith("macbookpro") || lower.StartsWith("macbookair"))
            return "laptopcomputer";
        if (lower.StartsWith("macstudio")) return "macstudio";
        if (lower.StartsWith("macmini"))   return "macmini";
        if (lower.StartsWith("imac") || lower.StartsWith("macpro")) return "desktopcomputer";

        if (lower.StartsWith("mac") && friendlyName != null)
        {
            var fn = friendlyName.ToLowerInvariant();
            if (fn.Contains("macbook"))   return "laptopcomputer";
            if (fn.Contains("imac"))      return "desktopcomputer";
            if (fn.Contains("mac mini"))  return "macmini";
            if (fn.Contains("mac studio")) return "macstudio";
            if (fn.Contains("mac pro"))   return "desktopcomputer";
        }

        return null;
    }

    private static string? FallbackSymbol(string familyRaw, string modelIdentifier)
    {
        var family = familyRaw.Trim();
        if (family.Length == 0) return null;

        return family.ToLowerInvariant() switch
        {
            "ipad"    => "ipad",
            "iphone"  => "iphone",
            "mac"     => "laptopcomputer",
            "android" => "android",
            "linux"   => "cpu",
            _         => "cpu",
        };
    }

    private static Dictionary<string, string> LoadModelIdentifierToName()
    {
        var combined = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        Merge(combined, LoadMapping("ios-device-identifiers"));
        Merge(combined, LoadMapping("mac-device-identifiers"));
        return combined;
    }

    private static void Merge(Dictionary<string, string> target, Dictionary<string, string> source)
    {
        // current wins on conflict — same as Swift uniquingKeysWith: { current, _ in current }
        foreach (var (k, v) in source)
            target.TryAdd(k, v);
    }

    private static Dictionary<string, string> LoadMapping(string resourceName)
    {
        var logicalName = $"{ResourceSubdirectory}.{resourceName}.json";
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream(logicalName);
        if (stream is null) return [];

        try
        {
            var doc = JsonDocument.Parse(stream);
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                var normalized = NormalizeNameValue(prop.Value);
                if (normalized is not null)
                    result[prop.Name] = normalized;
            }
            return result;
        }
        catch
        {
            return [];
        }
    }

    private static string? NormalizeNameValue(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            var s = element.GetString()?.Trim();
            return string.IsNullOrEmpty(s) ? null : s;
        }

        if (element.ValueKind == JsonValueKind.Array)
        {
            var values = element.EnumerateArray()
                .Select(e => e.GetString()?.Trim() ?? string.Empty)
                .Where(s => s.Length > 0)
                .ToList();
            return values.Count == 0 ? null : string.Join(" / ", values);
        }

        return null;
    }
}
