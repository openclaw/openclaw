using System.Text.RegularExpressions;
using Jint;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Infrastructure.Catalog;

/// <summary>
/// Loads the AI model catalog from a models.generated.js file produced by the gateway.
/// Uses Jint (pure .NET JS engine, ARM64-safe) to evaluate the generated JS.
/// </summary>
internal static partial class ModelCatalogLoader
{
    // Tunables
    private const string CacheRelativePath = "model-catalog/models.generated.js"; // within AppData/OpenClaw
    private const string NodeModulesRelativePath = "node_modules/@mariozechner/pi-ai/dist/models.generated.js";

    private static readonly string _appSupportDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OpenClaw");

    private static string CachePath =>
        Path.Combine(_appSupportDir, CacheRelativePath);

    internal static string DefaultPath => ResolveDefaultPath();

    internal static async Task<IReadOnlyList<ModelChoice>> LoadAsync(string path, CancellationToken ct = default)
    {
        var expanded = Environment.ExpandEnvironmentVariables(path.Replace("~", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
        var resolved = ResolvePath(preferred: expanded);
        if (resolved is null)
        {
            Log.Warning("[ModelCatalogLoader] model catalog load failed: file not found");
            throw new InvalidOperationException("Model catalog file not found");
        }

        Log.Debug("[ModelCatalogLoader] model catalog load start file={File}", Path.GetFileName(resolved.Value.Path));
        var source = await File.ReadAllTextAsync(resolved.Value.Path, ct);
        var sanitized = Sanitize(source);

        var choices = EvaluateModels(sanitized);
        var sorted = choices
            .OrderBy(c => c.Provider, StringComparer.OrdinalIgnoreCase)
            .ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        Log.Debug("[ModelCatalogLoader] model catalog loaded models={Count}", sorted.Count);
        if (resolved.Value.ShouldCache)
            CacheCatalog(resolved.Value.Path);

        return sorted;
    }

    // Visible for testing
    internal static string Sanitize(string source)
    {
        var exportIdx = source.IndexOf("export const MODELS", StringComparison.Ordinal);
        if (exportIdx < 0)
            return "var MODELS = {}";

        var afterExport = source.AsSpan(exportIdx + "export const MODELS".Length);
        var firstBrace = afterExport.IndexOf('{');
        if (firstBrace < 0)
            return "var MODELS = {}";

        var lastBrace = source.LastIndexOf('}');
        if (lastBrace < 0)
            return "var MODELS = {}";

        var body = source[(exportIdx + "export const MODELS".Length + firstBrace)..(lastBrace + 1)];

        // Strip TypeScript-only annotations (same regexes as Swift sanitize)
        body = SatisfiesPattern().Replace(body, string.Empty);
        body = AsPattern().Replace(body, string.Empty);

        return $"var MODELS = {body};";
    }

    private static IReadOnlyList<ModelChoice> EvaluateModels(string sanitized)
    {
        try
        {
            var engine = new Engine();
            engine.Execute(sanitized);

            var modelsValue = engine.GetValue("MODELS");
            if (modelsValue.IsUndefined() || modelsValue.IsNull())
            {
                Log.Warning("[ModelCatalogLoader] model catalog parse failed: MODELS missing");
                return [];
            }

            var choices = new List<ModelChoice>();
            foreach (var providerProp in modelsValue.AsObject().GetOwnProperties())
            {
                var provider = providerProp.Key.AsString();
                var providerObj = providerProp.Value.Value;
                if (providerObj is null || providerObj.IsUndefined()) continue;

                foreach (var modelProp in providerObj.AsObject().GetOwnProperties())
                {
                    var id = modelProp.Key.AsString();
                    var payload = modelProp.Value.Value;
                    if (payload is null || payload.IsUndefined()) continue;

                    var payloadObj = payload.AsObject();
                    var nameVal = payloadObj.Get("name");
                    var name = (!nameVal.IsUndefined() && !nameVal.IsNull()) ? nameVal.AsString() : id;
                    var ctxVal = payloadObj.Get("contextWindow");
                    int? contextWindow = (!ctxVal.IsUndefined() && !ctxVal.IsNull()) ? (int)ctxVal.AsNumber() : null;

                    choices.Add(new ModelChoice(id, name, provider, contextWindow));
                }
            }

            return choices;
        }
        catch (Exception ex)
        {
            Log.Warning(ex, "[ModelCatalogLoader] model catalog parse failed: JS evaluation error");
            return [];
        }
    }

    private static string ResolveDefaultPath()
    {
        var cache = CachePath;
        if (File.Exists(cache)) return cache;
        if (BundleCatalogPath() is { } bundlePath) return bundlePath;
        if (NodeModulesCatalogPath() is { } nodePath) return nodePath;
        return cache;
    }

    private static (string Path, bool ShouldCache)? ResolvePath(string preferred)
    {
        if (File.Exists(preferred))
            return (preferred, preferred != CachePath);

        if (BundleCatalogPath() is { } bundlePath && bundlePath != preferred)
        {
            Log.Warning("[ModelCatalogLoader] model catalog path missing; falling back to bundled catalog");
            return (bundlePath, true);
        }

        var cache = CachePath;
        if (cache != preferred && File.Exists(cache))
        {
            Log.Warning("[ModelCatalogLoader] model catalog path missing; falling back to cached catalog");
            return (cache, false);
        }

        if (NodeModulesCatalogPath() is { } nodePath && nodePath != preferred)
        {
            Log.Warning("[ModelCatalogLoader] model catalog path missing; falling back to node_modules catalog");
            return (nodePath, true);
        }

        return null;
    }

    private static string? BundleCatalogPath()
    {
        // Look for models.generated.js adjacent to the app executable
        var appDir = AppContext.BaseDirectory;
        var candidate = Path.Combine(appDir, "models.generated.js");
        return File.Exists(candidate) ? candidate : null;
    }

    private static string? NodeModulesCatalogPath()
    {
        var roots = new[]
        {
            AppContext.BaseDirectory,
            Directory.GetCurrentDirectory(),
        };

        foreach (var root in roots)
        {
            var candidate = Path.Combine(root, NodeModulesRelativePath);
            if (File.Exists(candidate))
                return candidate;
        }

        return null;
    }

    private static void CacheCatalog(string sourcePath)
    {
        var destination = CachePath;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            if (File.Exists(destination))
                File.Delete(destination);
            File.Copy(sourcePath, destination);
            Log.Debug("[ModelCatalogLoader] model catalog cached file={File}", Path.GetFileName(destination));
        }
        catch (Exception ex)
        {
            Log.Warning(ex, "[ModelCatalogLoader] model catalog cache failed");
        }
    }

    [GeneratedRegex(@"(?m)\bsatisfies\s+[^,}\n]+")]
    private static partial Regex SatisfiesPattern();

    [GeneratedRegex(@"(?m)\bas\s+[^;,\n]+")]
    private static partial Regex AsPattern();
}
