using System.Text.Json;
using OpenClawWindows.Presentation.Helpers;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class JsonObjectExtractionSupportTests
{
    [Fact]
    public void Extract_PlainJson_ReturnsTextAndObject()
    {
        var result = JsonObjectExtractionSupport.Extract("{\"key\":\"value\"}");
        Assert.NotNull(result);
        Assert.Equal("{\"key\":\"value\"}", result!.Value.Text);
        Assert.True(result.Value.Object.ContainsKey("key"));
        Assert.Equal("value", result.Value.Object["key"].GetString());
    }

    [Fact]
    public void Extract_JsonWithLeadingTrailingText_ExtractsBraceSubstring()
    {
        // Mirrors Swift: firstIndex(of:"{") / lastIndex(of:"}") strips surrounding text.
        var result = JsonObjectExtractionSupport.Extract("some prefix {\"a\":1} some suffix");
        Assert.NotNull(result);
        Assert.Equal("{\"a\":1}", result!.Value.Text);
        Assert.Equal(1, result.Value.Object["a"].GetInt32());
    }

    [Fact]
    public void Extract_NoBraces_ReturnsNull()
    {
        Assert.Null(JsonObjectExtractionSupport.Extract("no braces here"));
    }

    [Fact]
    public void Extract_EmptyString_ReturnsNull()
    {
        Assert.Null(JsonObjectExtractionSupport.Extract(string.Empty));
    }

    [Fact]
    public void Extract_WhitespaceOnly_ReturnsNull()
    {
        Assert.Null(JsonObjectExtractionSupport.Extract("   \n\t  "));
    }

    [Fact]
    public void Extract_InvalidJson_ReturnsNull()
    {
        Assert.Null(JsonObjectExtractionSupport.Extract("{not valid json}"));
    }

    [Fact]
    public void Extract_JsonArray_ReturnsNull()
    {
        // Swift: JSONSerialization cast to [String: Any] fails for arrays.
        Assert.Null(JsonObjectExtractionSupport.Extract("[1,2,3]"));
    }

    [Fact]
    public void Extract_NestedObject_ReturnsOutermostBraces()
    {
        // lastIndex(of:"}") ensures the outermost closing brace is used.
        var json = "{\"outer\":{\"inner\":42}}";
        var result = JsonObjectExtractionSupport.Extract(json);
        Assert.NotNull(result);
        Assert.Equal(json, result!.Value.Text);
        Assert.True(result.Value.Object.ContainsKey("outer"));
    }

    [Fact]
    public void Extract_LeadingWhitespace_TrimsBeforeSearch()
    {
        var result = JsonObjectExtractionSupport.Extract("  \n{\"x\":true}  ");
        Assert.NotNull(result);
        Assert.Equal("{\"x\":true}", result!.Value.Text);
    }

    [Fact]
    public void Extract_MultipleTopLevelKeys_ReturnsAllKeys()
    {
        var result = JsonObjectExtractionSupport.Extract("{\"a\":1,\"b\":2,\"c\":3}");
        Assert.NotNull(result);
        Assert.Equal(3, result!.Value.Object.Count);
    }
}
