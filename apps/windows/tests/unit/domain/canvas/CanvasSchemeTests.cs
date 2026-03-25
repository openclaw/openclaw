using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Tests.Unit.Domain.Canvas;

public sealed class CanvasSchemeTests
{
    // ── Scheme constants ──────────────────────────────────────────────────────

    [Fact]
    public void Scheme_IsOpenclawCanvas()
    {
        Assert.Equal("openclaw-canvas", CanvasScheme.Scheme);
    }

    [Fact]
    public void AllSchemes_ContainsOnlyTheScheme()
    {
        Assert.Single(CanvasScheme.AllSchemes);
        Assert.Equal("openclaw-canvas", CanvasScheme.AllSchemes[0]);
    }

    // ── MakeUri ───────────────────────────────────────────────────────────────

    [Fact]
    public void MakeUri_SessionOnly_PathIsSlash()
    {
        // mirrors Swift: makeURL(session: "abc123") → "openclaw-canvas://abc123/"
        var uri = CanvasScheme.MakeUri("abc123");

        Assert.NotNull(uri);
        Assert.Equal("openclaw-canvas", uri!.Scheme);
        Assert.Equal("abc123", uri.Host);
        Assert.Equal("/", uri.AbsolutePath);
    }

    [Fact]
    public void MakeUri_WithAbsolutePath_UsesPath()
    {
        var uri = CanvasScheme.MakeUri("sess", "/index.html");

        Assert.NotNull(uri);
        Assert.Equal("/index.html", uri!.AbsolutePath);
    }

    [Fact]
    public void MakeUri_WithRelativePath_PrependSlash()
    {
        // mirrors Swift: p.hasPrefix("/") else { "/" + p }
        var uri = CanvasScheme.MakeUri("sess", "assets/app.js");

        Assert.NotNull(uri);
        Assert.Equal("/assets/app.js", uri!.AbsolutePath);
    }

    [Fact]
    public void MakeUri_NullPath_PathIsSlash()
    {
        var uri = CanvasScheme.MakeUri("sess", null);

        Assert.NotNull(uri);
        Assert.Equal("/", uri!.AbsolutePath);
    }

    [Fact]
    public void MakeUri_EmptyPath_PathIsSlash()
    {
        var uri = CanvasScheme.MakeUri("sess", "");

        Assert.NotNull(uri);
        Assert.Equal("/", uri!.AbsolutePath);
    }

    [Fact]
    public void MakeUri_SlashPath_PathIsSlash()
    {
        var uri = CanvasScheme.MakeUri("sess", "/");

        Assert.NotNull(uri);
        Assert.Equal("/", uri!.AbsolutePath);
    }

    // ── MimeType ──────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("html",   "text/html")]
    [InlineData("htm",    "text/html")]
    [InlineData("js",     "application/javascript")]
    [InlineData("mjs",    "application/javascript")]
    [InlineData("css",    "text/css")]
    [InlineData("json",   "application/json")]
    [InlineData("map",    "application/json")]
    [InlineData("svg",    "image/svg+xml")]
    [InlineData("png",    "image/png")]
    [InlineData("jpg",    "image/jpeg")]
    [InlineData("jpeg",   "image/jpeg")]
    [InlineData("gif",    "image/gif")]
    [InlineData("ico",    "image/x-icon")]
    [InlineData("woff2",  "font/woff2")]
    [InlineData("woff",   "font/woff")]
    [InlineData("ttf",    "font/ttf")]
    [InlineData("wasm",   "application/wasm")]
    public void MimeType_KnownExtensions_ReturnCorrectType(string ext, string expected)
    {
        Assert.Equal(expected, CanvasScheme.MimeType(ext));
    }

    [Fact]
    public void MimeType_UnknownExtension_ReturnsOctetStream()
    {
        // mirrors Swift: default → "application/octet-stream"
        Assert.Equal("application/octet-stream", CanvasScheme.MimeType("xyz"));
        Assert.Equal("application/octet-stream", CanvasScheme.MimeType("bin"));
    }

    [Fact]
    public void MimeType_UppercaseExtension_IsCaseInsensitive()
    {
        Assert.Equal("text/html",             CanvasScheme.MimeType("HTML"));
        Assert.Equal("application/javascript", CanvasScheme.MimeType("JS"));
    }
}
