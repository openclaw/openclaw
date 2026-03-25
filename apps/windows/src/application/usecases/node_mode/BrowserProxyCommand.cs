using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using OpenClawWindows.Application.Behaviors;

namespace OpenClawWindows.Application.NodeMode;

// Proxies a browser-automation HTTP request to the gateway's control endpoint.
public sealed record BrowserProxyCommand(string? ParamsJson) : IRequest<ErrorOr<string>>;

[UseCase("UC-001-BROWSER-PROXY")]
internal sealed class BrowserProxyHandler : IRequestHandler<BrowserProxyCommand, ErrorOr<string>>
{
    // Tunables
    private const int ControlPortOffset  = 2;              // gatewayPort() + 2 (18789 + 2 = 18791)
    private const int GatewayBasePort    = 18789;
    private const int MaxFileSizeBytes   = 10 * 1024 * 1024;
    private const int DefaultTimeoutSec  = 5;

    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<BrowserProxyHandler> _logger;

    public BrowserProxyHandler(IHttpClientFactory httpFactory, ILogger<BrowserProxyHandler> logger)
    {
        _httpFactory = httpFactory;
        _logger = logger;
    }

    public async Task<ErrorOr<string>> Handle(BrowserProxyCommand cmd, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(cmd.ParamsJson))
            return Error.Failure("BROWSER_PROXY.INVALID", "INVALID_REQUEST: paramsJSON required");

        RequestParams? p;
        try
        {
            p = JsonSerializer.Deserialize<RequestParams>(cmd.ParamsJson, JsonOpts);
        }
        catch (Exception ex)
        {
            return Error.Failure("BROWSER_PROXY.INVALID", $"INVALID_REQUEST: {ex.Message}");
        }

        if (p is null)
            return Error.Failure("BROWSER_PROXY.INVALID", "INVALID_REQUEST: paramsJSON required");

        var path = (p.Path ?? "").Trim();
        if (path.Length == 0)
            return Error.Failure("BROWSER_PROXY.INVALID", "INVALID_REQUEST: path required");

        var method = (p.Method ?? "GET").Trim().ToUpperInvariant();
        var normalizedPath = path.StartsWith('/') ? path : $"/{path}";

        // Build URL with query string
        var baseUrl = $"http://127.0.0.1:{GatewayBasePort + ControlPortOffset}";
        var uriBuilder = new UriBuilder(baseUrl + normalizedPath);

        var queryParts = new List<string>();
        if (p.Query is not null)
        {
            foreach (var (key, value) in p.Query.OrderBy(kv => kv.Key))
            {
                var sv = ScalarToString(value);
                if (sv is null) continue;
                queryParts.Add($"{Uri.EscapeDataString(key)}={Uri.EscapeDataString(sv)}");
            }
        }

        var profile = (p.Profile ?? "").Trim();
        if (profile.Length > 0 && !queryParts.Any(q => q.StartsWith("profile=")))
            queryParts.Add($"profile={Uri.EscapeDataString(profile)}");

        if (queryParts.Count > 0)
            uriBuilder.Query = string.Join("&", queryParts);

        var timeout = p.TimeoutMs.HasValue
            ? TimeSpan.FromMilliseconds(Math.Max(p.TimeoutMs.Value, 1))
            : TimeSpan.FromSeconds(DefaultTimeoutSec);

        var client = _httpFactory.CreateClient("browser-proxy");
        client.Timeout = timeout;

        using var request = new HttpRequestMessage(new HttpMethod(method), uriBuilder.Uri);
        request.Headers.Add("Accept", "application/json");

        if (method != "GET" && p.Body.HasValue)
        {
            var bodyJson = p.Body.Value.GetRawText();
            request.Content = new StringContent(bodyJson, Encoding.UTF8, "application/json");
        }

        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Browser proxy request failed");
            return Error.Failure("BROWSER_PROXY.FAILED", ex.Message);
        }

        var responseBytes = await response.Content.ReadAsByteArrayAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            var errMsg = BuildHttpErrorMessage((int)response.StatusCode, responseBytes);
            return Error.Failure("BROWSER_PROXY.HTTP_ERROR", errMsg);
        }

        // Parse the gateway response, attach any referenced files as base64.
        object? resultObj;
        try
        {
            resultObj = JsonSerializer.Deserialize<JsonElement>(responseBytes, JsonOpts);
        }
        catch
        {
            resultObj = null;
        }

        var filePaths = CollectProxyPaths(resultObj);
        var files = LoadProxyFiles(filePaths);

        var payload = new Dictionary<string, object?> { ["result"] = resultObj };
        if (files.Count > 0)
            payload["files"] = files;

        return JsonSerializer.Serialize(payload, JsonOpts);
    }

    // ── HTTP error message

    private static string BuildHttpErrorMessage(int statusCode, byte[] data)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            if (doc.RootElement.TryGetProperty("error", out var errProp))
            {
                var errStr = errProp.GetString()?.Trim();
                if (!string.IsNullOrEmpty(errStr)) return errStr;
            }
        }
        catch { }

        var text = Encoding.UTF8.GetString(data).Trim();
        return text.Length > 0 ? text : $"HTTP {statusCode}";
    }

    // ── File collection

    private static IReadOnlyList<string> CollectProxyPaths(object? result)
    {
        if (result is not JsonElement el || el.ValueKind != JsonValueKind.Object)
            return [];

        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (el.TryGetProperty("path", out var p) && p.GetString()?.Trim() is { Length: > 0 } pv)
            paths.Add(pv);

        if (el.TryGetProperty("imagePath", out var ip) && ip.GetString()?.Trim() is { Length: > 0 } ipv)
            paths.Add(ipv);

        if (el.TryGetProperty("download", out var dl) &&
            dl.ValueKind == JsonValueKind.Object &&
            dl.TryGetProperty("path", out var dp) &&
            dp.GetString()?.Trim() is { Length: > 0 } dpv)
        {
            paths.Add(dpv);
        }

        return [.. paths.OrderBy(x => x)];
    }

    // ── File loading

    private IReadOnlyList<object> LoadProxyFiles(IReadOnlyList<string> paths)
    {
        var result = new List<object>();
        foreach (var path in paths)
        {
            try
            {
                var info = new FileInfo(path);
                if (!info.Exists || !info.Attributes.HasFlag(FileAttributes.Normal | FileAttributes.Archive))
                    continue;

                if (info.Length > MaxFileSizeBytes)
                {
                    _logger.LogWarning("Browser proxy file exceeds 10 MB: {Path}", path);
                    continue;
                }

                var bytes = File.ReadAllBytes(path);
                var base64 = Convert.ToBase64String(bytes);
                var mimeType = GetMimeType(Path.GetExtension(path));

                var entry = new Dictionary<string, object?> { ["path"] = path, ["base64"] = base64 };
                if (mimeType is not null) entry["mimeType"] = mimeType;
                result.Add(entry);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Browser proxy could not load file: {Path}", path);
            }
        }
        return result;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Converts a JsonElement scalar to its string representation for query params.
    private static string? ScalarToString(JsonElement el)
    {
        return el.ValueKind switch
        {
            JsonValueKind.String  => el.GetString(),
            JsonValueKind.True    => "true",
            JsonValueKind.False   => "false",
            JsonValueKind.Number  => el.GetRawText(),
            JsonValueKind.Null    => null,
            _                     => null,
        };
    }

    // Basic MIME type map (subset)
    private static string? GetMimeType(string ext) => ext.ToLowerInvariant() switch
    {
        ".jpg" or ".jpeg" => "image/jpeg",
        ".png"            => "image/png",
        ".gif"            => "image/gif",
        ".webp"           => "image/webp",
        ".mp4"            => "video/mp4",
        ".mov"            => "video/quicktime",
        ".pdf"            => "application/pdf",
        ".json"           => "application/json",
        ".txt"            => "text/plain",
        _                 => null,
    };

    // ── DTOs ──────────────────────────────────────────────────────────────────

    private sealed class RequestParams
    {
        [System.Text.Json.Serialization.JsonPropertyName("method")]
        public string? Method { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("path")]
        public string? Path { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("query")]
        public Dictionary<string, JsonElement>? Query { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("body")]
        public JsonElement? Body { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("timeoutMs")]
        public int? TimeoutMs { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("profile")]
        public string? Profile { get; set; }
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy     = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };
}
