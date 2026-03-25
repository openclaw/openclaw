using System.Reflection;
using System.Text;
using Microsoft.Web.WebView2.Core;
using OpenClawWindows.Domain.Canvas;
using Windows.Storage.Streams;

namespace OpenClawWindows.Presentation.Canvas;

/// <summary>
/// WebView2 adapter that serves local canvas session files under the canvas.local virtual host.
/// WebView2 WebResourceRequested for https://canvas.local/* (Windows virtual host equivalent).
/// Adds directory traversal guard, index resolution, and scaffold page that SetVirtualHostNameToFolderMapping lacks.
/// </summary>
internal sealed class CanvasSchemeHandlerAdapter
{
    private readonly string _root;

    // root is the canvas-host directory
    internal CanvasSchemeHandlerAdapter(string root)
    {
        _root = root;
    }

    // Registers this handler with an initialized CoreWebView2 instance.
    // Replaces SetVirtualHostNameToFolderMapping with a secured handler that applies traversal guard.
    internal void Attach(CoreWebView2 webView)
    {
        webView.AddWebResourceRequestedFilter(
            "https://canvas.local/*",
            CoreWebView2WebResourceContext.All);
        webView.WebResourceRequested += OnWebResourceRequested;
    }

    private void OnWebResourceRequested(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out var uri))
        {
            _ = RespondAsync(sender, args, args.GetDeferral(), 400, "Bad Request", "text/plain",
                Encoding.UTF8.GetBytes("missing url"));
            return;
        }

        var (mime, data) = BuildResponse(uri);
        var encoding = TextEncodingName(mime);
        var contentType = encoding is not null ? $"{mime}; charset={encoding}" : mime;
        _ = RespondAsync(sender, args, args.GetDeferral(), 200, "OK", contentType, data);
    }

    private static async Task RespondAsync(
        CoreWebView2 webView,
        CoreWebView2WebResourceRequestedEventArgs args,
        IDisposable deferral,
        int status, string reason, string contentType, byte[] data)
    {
        using (deferral)
        {
            var ras = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(ras))
            {
                writer.WriteBytes(data);
                await writer.StoreAsync();
                writer.DetachStream();
            }
            ras.Seek(0);
            args.Response = webView.Environment.CreateWebResourceResponse(
                ras, status, reason, $"Content-Type: {contentType}");
        }
    }

    internal (string mime, byte[] data) BuildResponse(Uri uri)
    {
        // Extract session from first path segment: https://canvas.local/{session}/...
        var segments = uri.AbsolutePath.TrimStart('/').Split('/', 2);
        var session = segments[0];

        if (string.IsNullOrEmpty(session))
            return Html("Missing session.");

        if (session.Contains('\\') || session.Contains(".."))
            return Html("Invalid session.");

        var sessionRoot = Path.Combine(_root, session);

        var path = segments.Length > 1 ? segments[1] : string.Empty;
        var qIdx = path.IndexOf('?');
        if (qIdx >= 0) path = path[..qIdx];
        path = Uri.UnescapeDataString(path);

        if (string.IsNullOrEmpty(path))
        {
            var indexA = Path.Combine(sessionRoot, "index.html");
            var indexB = Path.Combine(sessionRoot, "index.htm");
            if (!File.Exists(indexA) && !File.Exists(indexB))
                return ScaffoldPage(sessionRoot);
        }

        var resolved = ResolveFileUrl(sessionRoot, path);
        if (resolved is null)
            return Html("Not Found", "Canvas: 404");

        var standardRoot = Path.GetFullPath(sessionRoot);
        if (!standardRoot.EndsWith(Path.DirectorySeparatorChar))
            standardRoot += Path.DirectorySeparatorChar;
        var standardFile = Path.GetFullPath(resolved);
        if (!standardFile.StartsWith(standardRoot, StringComparison.OrdinalIgnoreCase))
            return Html("Forbidden", "Canvas: 403");

        try
        {
            var fileData = File.ReadAllBytes(standardFile);
            var ext = Path.GetExtension(standardFile).TrimStart('.');
            var mime = CanvasScheme.MimeType(ext);
            return (mime, fileData);
        }
        catch
        {
            return Html("Failed to read file.", "Canvas error");
        }
    }

    private static string? ResolveFileUrl(string sessionRoot, string requestPath)
    {
        if (string.IsNullOrEmpty(requestPath))
            return ResolveIndex(sessionRoot);

        var candidate = Path.Combine(sessionRoot, requestPath);

        if (File.Exists(candidate))
            return candidate;

        if (Directory.Exists(candidate))
            return ResolveIndex(candidate);

        return null;
    }

    private static string? ResolveIndex(string dir)
    {
        var a = Path.Combine(dir, "index.html");
        if (File.Exists(a)) return a;
        var b = Path.Combine(dir, "index.htm");
        if (File.Exists(b)) return b;
        return null;
    }

    private static (string mime, byte[] data) Html(string body, string title = "Canvas")
    {
        // Uses $$"""...""" so CSS braces need no escaping; interpolations use {{expr}}.
        var html = $$"""
            <!doctype html>
            <html>
              <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>{{title}}</title>
                <style>
                  :root { color-scheme: light; }
                  html,body { height:100%; margin:0; }
                  body {
                    font: 13px -apple-system, system-ui;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    background: #fff;
                    color:#111827;
                  }
                  .card {
                    max-width: 520px;
                    padding: 18px 18px;
                    border-radius: 12px;
                    border: 1px solid rgba(0,0,0,.08);
                    box-shadow: 0 10px 30px rgba(0,0,0,.08);
                  }
                  .muted { color:#6b7280; margin-top:8px; }
                  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
                </style>
              </head>
              <body>
                <div class="card">
                  <div>{{body}}</div>
                </div>
              </body>
            </html>
            """;
        return ("text/html", Encoding.UTF8.GetBytes(html));
    }

    private static (string mime, byte[] data) WelcomePage(string sessionRoot)
    {
        var escaped = sessionRoot
            .Replace("&", "&amp;")
            .Replace("<", "&lt;")
            .Replace(">", "&gt;");
        var body = $$"""
            <div style="font-weight:600; font-size:14px;">Canvas is ready.</div>
            <div class="muted">Create <code>index.html</code> in:</div>
            <div style="margin-top:10px;"><code>{{escaped}}</code></div>
            """;
        return Html(body, "Canvas");
    }

    private static (string mime, byte[] data) ScaffoldPage(string sessionRoot)
    {
        var data = LoadBundledResourceData("CanvasScaffold/scaffold.html");
        if (data is not null)
            return ("text/html", data);

        // Fallback for dev misconfiguration: show the classic welcome page.
        return WelcomePage(sessionRoot);
    }

    private static byte[]? LoadBundledResourceData(string relativePath)
    {
        var trimmed = relativePath.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        if (trimmed.Contains("..") || trimmed.Contains('\\')) return null;

        var assembly = Assembly.GetEntryAssembly();
        if (assembly is null) return null;

        var resourceName = assembly.GetName().Name + "." + trimmed.Replace('/', '.');
        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream is null) return null;

        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    private static string? TextEncodingName(string mimeType)
    {
        if (mimeType.StartsWith("text/", StringComparison.OrdinalIgnoreCase))
            return "utf-8";
        return mimeType switch
        {
            "application/javascript" or "application/json" or "image/svg+xml" => "utf-8",
            _ => null,
        };
    }
}
