using OpenClawWindows.Presentation.Canvas;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class CanvasSchemeHandlerAdapterTests : IDisposable
{
    private readonly string _root;
    private readonly CanvasSchemeHandlerAdapter _adapter;

    public CanvasSchemeHandlerAdapterTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "ocw_canvas_test_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
        _adapter = new CanvasSchemeHandlerAdapter(_root);
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { /* best-effort */ }
    }

    // mirrors Swift: session validation (session is first path segment under canvas.local)

    [Fact]
    public void BuildResponse_MissingSession_ReturnsHtmlBody()
    {
        var uri = new Uri("https://canvas.local/");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("text/html");
        System.Text.Encoding.UTF8.GetString(data).Should().Contain("Missing session");
    }

    [Theory]
    [InlineData("..evil")]
    public void BuildResponse_SessionContainsDotDot_ReturnsHtmlBody(string session)
    {
        // mirrors Swift: if session.contains("/") || session.contains("..")
        // Note: ".." alone is normalized by .NET Uri before reaching this adapter.
        var uri = new Uri($"https://canvas.local/{session}/index.html");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("text/html");
        System.Text.Encoding.UTF8.GetString(data).Should().Contain("Invalid session");
    }

    // ── file serving ──────────────────────────────────────────────────────────

    [Fact]
    public void BuildResponse_ExistingFile_ServesContentWithCorrectMime()
    {
        var sessionDir = Path.Combine(_root, "sess1");
        Directory.CreateDirectory(sessionDir);
        File.WriteAllText(Path.Combine(sessionDir, "app.js"), "console.log('hi');");

        var uri = new Uri("https://canvas.local/sess1/app.js");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("application/javascript");
        System.Text.Encoding.UTF8.GetString(data).Should().Be("console.log('hi');");
    }

    [Fact]
    public void BuildResponse_HtmlFile_ServesWithTextHtmlMime()
    {
        var sessionDir = Path.Combine(_root, "sess2");
        Directory.CreateDirectory(sessionDir);
        File.WriteAllText(Path.Combine(sessionDir, "index.html"), "<html/>");

        var uri = new Uri("https://canvas.local/sess2/index.html");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("text/html");
        System.Text.Encoding.UTF8.GetString(data).Should().Be("<html/>");
    }

    // ── index resolution ──────────────────────────────────────────────────────

    [Fact]
    public void BuildResponse_EmptySubPath_IndexHtmlExists_ServesIndex()
    {
        // mirrors Swift: special-case when root index is missing → serves index when it exists
        var sessionDir = Path.Combine(_root, "sess3");
        Directory.CreateDirectory(sessionDir);
        File.WriteAllText(Path.Combine(sessionDir, "index.html"), "root index");

        var uri = new Uri("https://canvas.local/sess3/");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("text/html");
        System.Text.Encoding.UTF8.GetString(data).Should().Be("root index");
    }

    [Fact]
    public void BuildResponse_EmptySubPath_IndexHtmExists_ServesIndex()
    {
        var sessionDir = Path.Combine(_root, "sess4");
        Directory.CreateDirectory(sessionDir);
        File.WriteAllText(Path.Combine(sessionDir, "index.htm"), "htm index");

        var uri = new Uri("https://canvas.local/sess4/");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("text/html");
        System.Text.Encoding.UTF8.GetString(data).Should().Be("htm index");
    }

    [Fact]
    public void BuildResponse_EmptySubPath_NoIndex_ReturnsScaffoldOrWelcome()
    {
        // mirrors Swift: scaffoldPage → welcomePage when scaffold bundle resource is missing
        var sessionDir = Path.Combine(_root, "sess5");
        Directory.CreateDirectory(sessionDir);

        var uri = new Uri("https://canvas.local/sess5/");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("text/html");
        System.Text.Encoding.UTF8.GetString(data).Should().NotBeEmpty();
    }

    [Fact]
    public void BuildResponse_DirectoryRequest_ResolvesToIndexHtml()
    {
        // mirrors Swift: resolveFileURL — if isDirectory returns resolveIndex(in: candidate)
        var sessionDir = Path.Combine(_root, "sess6");
        var subDir = Path.Combine(sessionDir, "sub");
        Directory.CreateDirectory(subDir);
        File.WriteAllText(Path.Combine(subDir, "index.html"), "sub index");

        var uri = new Uri("https://canvas.local/sess6/sub");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("text/html");
        System.Text.Encoding.UTF8.GetString(data).Should().Be("sub index");
    }

    // ── not found ─────────────────────────────────────────────────────────────

    [Fact]
    public void BuildResponse_FileNotFound_Returns404Html()
    {
        var sessionDir = Path.Combine(_root, "sess7");
        Directory.CreateDirectory(sessionDir);

        var uri = new Uri("https://canvas.local/sess7/missing.html");
        var (mime, data) = _adapter.BuildResponse(uri);

        mime.Should().Be("text/html");
        System.Text.Encoding.UTF8.GetString(data).Should().Contain("Not Found");
    }

    // ── directory traversal guard ─────────────────────────────────────────────

    [Fact]
    public void BuildResponse_TraversalAttempt_ReturnsForbiddenOrNotFound()
    {
        // mirrors Swift: directory traversal guard
        var sessionDir = Path.Combine(_root, "sess8");
        Directory.CreateDirectory(sessionDir);
        File.WriteAllText(Path.Combine(_root, "secret.txt"), "secret");

        // URL-encoded traversal: ../secret.txt
        var uri = new Uri("https://canvas.local/sess8/%2e%2e%2fsecret.txt");
        var (_, data) = _adapter.BuildResponse(uri);

        var html = System.Text.Encoding.UTF8.GetString(data);
        html.Should().Match(s => s.Contains("Forbidden") || s.Contains("Not Found"));
    }

    // ── text encoding ─────────────────────────────────────────────────────────

    [Theory]
    [InlineData("text/html",               "utf-8")]
    [InlineData("text/css",                "utf-8")]
    [InlineData("text/plain",              "utf-8")]
    [InlineData("application/javascript",  "utf-8")]
    [InlineData("application/json",        "utf-8")]
    [InlineData("image/svg+xml",           "utf-8")]
    public void TextEncodingName_TextAndKnownTypes_ReturnsUtf8(string mime, string expected)
    {
        // mirrors Swift: textEncodingName(forMimeType:)
        typeof(CanvasSchemeHandlerAdapter)
            .GetMethod("TextEncodingName",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!
            .Invoke(null, [mime])
            .Should().Be(expected);
    }

    [Theory]
    [InlineData("image/png")]
    [InlineData("image/jpeg")]
    [InlineData("application/octet-stream")]
    [InlineData("font/woff2")]
    public void TextEncodingName_BinaryTypes_ReturnsNull(string mime)
    {
        typeof(CanvasSchemeHandlerAdapter)
            .GetMethod("TextEncodingName",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!
            .Invoke(null, [mime])
            .Should().BeNull();
    }
}
