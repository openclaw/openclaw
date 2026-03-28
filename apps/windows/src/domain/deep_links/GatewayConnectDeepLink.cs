namespace OpenClawWindows.Domain.DeepLinks;

public sealed record GatewayConnectDeepLink(
    string  Host,
    int     Port,
    bool    Tls,
    string? Token,
    string? Password)
{
    public Uri? WebSocketUri => Uri.TryCreate(
        $"{(Tls ? "wss" : "ws")}://{Host}:{Port}", UriKind.Absolute, out var u) ? u : null;

    // Parses a device-pair setup code (base64url-encoded JSON: {url, token?, password?}).
    public static GatewayConnectDeepLink? FromSetupCode(string code)
    {
        var data = DecodeBase64Url(code);
        if (data is null) return null;

        Dictionary<string, object>? json;
        try { json = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, object>>(data); }
        catch { return null; }
        if (json is null) return null;

        if (!json.TryGetValue("url", out var urlObj) || urlObj?.ToString() is not { } urlStr) return null;
        if (!Uri.TryCreate(urlStr, UriKind.Absolute, out var parsed)) return null;

        var scheme = parsed.Scheme.ToLowerInvariant();
        if (scheme is not ("ws" or "wss")) return null;
        var tls = scheme == "wss";
        if (!tls && !IsLoopbackHost(parsed.Host)) return null;

        // parsed.Port returns the scheme default (80) even when the port is absent —
        // check the authority string: port is explicit only when it appears as :<port>.
        var port = parsed.Authority.EndsWith($":{parsed.Port}", StringComparison.Ordinal)
            ? parsed.Port
            : (tls ? 443 : 18789);
        var token    = json.TryGetValue("token",    out var t) ? t?.ToString() : null;
        var password = json.TryGetValue("password", out var p) ? p?.ToString() : null;
        return new GatewayConnectDeepLink(parsed.Host, port, tls, token, password);
    }

    private static byte[]? DecodeBase64Url(string input)
    {
        var s = input.Replace('-', '+').Replace('_', '/');
        var pad = s.Length % 4;
        if (pad > 0) s += new string('=', 4 - pad);
        try { return Convert.FromBase64String(s); }
        catch { return null; }
    }

    internal static bool IsLoopbackHost(string host) =>
        host is "localhost" or "127.0.0.1" or "::1";
}
