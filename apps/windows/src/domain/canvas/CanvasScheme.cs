namespace OpenClawWindows.Domain.Canvas;

/// <summary>
/// Defines the custom URL scheme used to serve canvas files from the local session directory.
/// </summary>
public static class CanvasScheme
{
    public const string Scheme = "openclaw-canvas";

    public static readonly string[] AllSchemes = [Scheme];

    public static Uri? MakeUri(string session, string? path = null)
    {
        var p = (path ?? "/").Trim();
        if (p.Length == 0 || p == "/")
            p = "/";
        else if (!p.StartsWith('/'))
            p = "/" + p;

        var builder = new UriBuilder
        {
            Scheme = Scheme,
            Host   = session,
            Path   = p,
        };
        try   { return builder.Uri; }
        catch { return null; }
    }

    public static string MimeType(string extension) =>
        extension.ToLowerInvariant() switch
        {
            "html" or "htm"  => "text/html",
            "js"   or "mjs"  => "application/javascript",
            "css"            => "text/css",
            "json" or "map"  => "application/json",
            "svg"            => "image/svg+xml",
            "png"            => "image/png",
            "jpg"  or "jpeg" => "image/jpeg",
            "gif"            => "image/gif",
            "ico"            => "image/x-icon",
            "woff2"          => "font/woff2",
            "woff"           => "font/woff",
            "ttf"            => "font/ttf",
            "wasm"           => "application/wasm",
            _                => "application/octet-stream",
        };
}
