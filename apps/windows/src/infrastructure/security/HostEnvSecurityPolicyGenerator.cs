using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenClawWindows.Infrastructure.Security;

/// <summary>
/// Reads src/infra/host-env-security-policy.json and generates
/// HostEnvSecurityPolicy.generated.cs, keeping Windows parity with the Swift
/// equivalent produced by generate-host-env-security-policy-swift.mjs.
/// </summary>
internal static class HostEnvSecurityPolicyGenerator
{
    private const string GeneratedHeader =
        "// Generated file. Do not edit directly.\n" +
        "// Source: src/infra/host-env-security-policy.json\n" +
        "// Regenerate: dotnet run --project apps/windows/tools/HostEnvSecurityPolicyGenerator -- --write\n";

    internal static string GenerateSource(string jsonPath)
    {
        var json = File.ReadAllText(jsonPath);
        var root = JsonNode.Parse(json)?.AsObject()
            ?? throw new InvalidOperationException($"Failed to parse {jsonPath}");

        var blockedKeys = ReadStringArray(root, "blockedKeys");
        var blockedOverrideKeys = ReadStringArray(root, "blockedOverrideKeys");
        var blockedOverridePrefixes = ReadStringArray(root, "blockedOverridePrefixes");
        var blockedPrefixes = ReadStringArray(root, "blockedPrefixes");

        var sb = new StringBuilder();
        sb.Append(GeneratedHeader);
        sb.AppendLine();
        sb.AppendLine("namespace OpenClawWindows.Infrastructure.Security;");
        sb.AppendLine();
        sb.AppendLine("static class HostEnvSecurityPolicy");
        sb.AppendLine("{");
        AppendHashSet(sb, "BlockedKeys", blockedKeys);
        sb.AppendLine();
        AppendHashSet(sb, "BlockedOverrideKeys", blockedOverrideKeys);
        sb.AppendLine();
        AppendArray(sb, "BlockedOverridePrefixes", blockedOverridePrefixes);
        sb.AppendLine();
        AppendArray(sb, "BlockedPrefixes", blockedPrefixes);
        sb.AppendLine("}");

        return sb.ToString();
    }

    // Returns true when the file was up-to-date, false when it was written.
    internal static bool Write(string jsonPath, string outputPath)
    {
        var generated = GenerateSource(jsonPath);
        var current = File.Exists(outputPath) ? File.ReadAllText(outputPath) : null;

        if (current == generated)
            return true;

        File.WriteAllText(outputPath, generated, Encoding.UTF8);
        return false;
    }

    // Returns true when the file is up-to-date, false when it is stale.
    internal static bool Check(string jsonPath, string outputPath)
    {
        var generated = GenerateSource(jsonPath);
        var current = File.Exists(outputPath) ? File.ReadAllText(outputPath) : null;
        return current == generated;
    }

    private static string[] ReadStringArray(JsonObject root, string key)
    {
        if (!root.TryGetPropertyValue(key, out var node) || node is not JsonArray arr)
            return [];
        return [.. arr.Select(e => e?.GetValue<string>() ?? string.Empty)];
    }

    private static void AppendHashSet(StringBuilder sb, string name, IReadOnlyList<string> items)
    {
        sb.AppendLine($"    internal static readonly HashSet<string> {name} = new(StringComparer.OrdinalIgnoreCase)");
        sb.AppendLine("    {");
        foreach (var item in items)
            sb.AppendLine($"        \"{item}\",");
        sb.AppendLine("    };");
    }

    private static void AppendArray(StringBuilder sb, string name, IReadOnlyList<string> items)
    {
        sb.AppendLine($"    internal static readonly string[] {name} =");
        sb.AppendLine("    [");
        foreach (var item in items)
            sb.AppendLine($"        \"{item}\",");
        sb.AppendLine("    ];");
    }
}
