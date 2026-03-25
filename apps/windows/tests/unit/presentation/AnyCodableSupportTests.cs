using System.Text.Json;
using OpenClawWindows.Presentation.Helpers;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class AnyCodableSupportTests
{
    // --- StringValue ---

    [Fact]
    public void StringValue_StringKind_ReturnsString()
    {
        var el = JsonDocument.Parse("\"hello\"").RootElement;
        Assert.Equal("hello", el.StringValue());
    }

    [Fact]
    public void StringValue_NonString_ReturnsNull()
    {
        var el = JsonDocument.Parse("42").RootElement;
        Assert.Null(el.StringValue());
    }

    // --- BoolValue ---

    [Fact]
    public void BoolValue_True_ReturnsTrue()
    {
        var el = JsonDocument.Parse("true").RootElement;
        Assert.Equal(true, el.BoolValue());
    }

    [Fact]
    public void BoolValue_False_ReturnsFalse()
    {
        var el = JsonDocument.Parse("false").RootElement;
        Assert.Equal(false, el.BoolValue());
    }

    [Fact]
    public void BoolValue_NonBool_ReturnsNull()
    {
        var el = JsonDocument.Parse("1").RootElement;
        Assert.Null(el.BoolValue());
    }

    // --- IntValue ---

    [Fact]
    public void IntValue_Integer_ReturnsInt()
    {
        var el = JsonDocument.Parse("42").RootElement;
        Assert.Equal(42, el.IntValue());
    }

    [Fact]
    public void IntValue_Float_ReturnsNull()
    {
        // TryGetInt32 fails for non-integer numbers
        var el = JsonDocument.Parse("3.14").RootElement;
        Assert.Null(el.IntValue());
    }

    [Fact]
    public void IntValue_NonNumber_ReturnsNull()
    {
        var el = JsonDocument.Parse("\"text\"").RootElement;
        Assert.Null(el.IntValue());
    }

    // --- DoubleValue ---

    [Fact]
    public void DoubleValue_Float_ReturnsDouble()
    {
        var el = JsonDocument.Parse("3.14").RootElement;
        Assert.Equal(3.14, el.DoubleValue());
    }

    [Fact]
    public void DoubleValue_Integer_ReturnsDouble()
    {
        var el = JsonDocument.Parse("7").RootElement;
        Assert.Equal(7.0, el.DoubleValue());
    }

    [Fact]
    public void DoubleValue_NonNumber_ReturnsNull()
    {
        var el = JsonDocument.Parse("true").RootElement;
        Assert.Null(el.DoubleValue());
    }

    // --- DictionaryValue ---

    [Fact]
    public void DictionaryValue_Object_ReturnsDictionary()
    {
        var el = JsonDocument.Parse("{\"a\":1,\"b\":\"x\"}").RootElement;
        var dict = el.DictionaryValue();
        Assert.NotNull(dict);
        Assert.Equal(2, dict!.Count);
        Assert.True(dict.ContainsKey("a"));
        Assert.True(dict.ContainsKey("b"));
    }

    [Fact]
    public void DictionaryValue_NonObject_ReturnsNull()
    {
        var el = JsonDocument.Parse("[1,2]").RootElement;
        Assert.Null(el.DictionaryValue());
    }

    // --- ArrayValue ---

    [Fact]
    public void ArrayValue_Array_ReturnsList()
    {
        var el = JsonDocument.Parse("[1,2,3]").RootElement;
        var arr = el.ArrayValue();
        Assert.NotNull(arr);
        Assert.Equal(3, arr!.Count);
    }

    [Fact]
    public void ArrayValue_NonArray_ReturnsNull()
    {
        var el = JsonDocument.Parse("{\"k\":\"v\"}").RootElement;
        Assert.Null(el.ArrayValue());
    }

    // --- FoundationValue ---

    [Fact]
    public void FoundationValue_String_ReturnsString()
    {
        var el = JsonDocument.Parse("\"world\"").RootElement;
        Assert.Equal("world", el.FoundationValue());
    }

    [Fact]
    public void FoundationValue_Bool_ReturnsBoxedBool()
    {
        var t = JsonDocument.Parse("true").RootElement;
        var f = JsonDocument.Parse("false").RootElement;
        Assert.True(t.FoundationValue() is true);
        Assert.True(f.FoundationValue() is false);
    }

    [Fact]
    public void FoundationValue_Integer_ReturnsLong()
    {
        var el = JsonDocument.Parse("99").RootElement;
        Assert.Equal(99L, el.FoundationValue());
    }

    [Fact]
    public void FoundationValue_Float_ReturnsDouble()
    {
        var el = JsonDocument.Parse("2.5").RootElement;
        Assert.Equal(2.5, el.FoundationValue());
    }

    [Fact]
    public void FoundationValue_Null_ReturnsNull()
    {
        var el = JsonDocument.Parse("null").RootElement;
        Assert.Null(el.FoundationValue());
    }

    [Fact]
    public void FoundationValue_NestedObject_ReturnsNestedDictionary()
    {
        // Mirrors Swift: foundationValue recursively unwraps [String: AnyCodable] to [String: Any]
        var el = JsonDocument.Parse("{\"tags\":[\"node\",\"ios\"],\"meta\":{\"count\":2}}").RootElement;
        var result = el.FoundationValue() as Dictionary<string, object?>;
        Assert.NotNull(result);
        var tags = result!["tags"] as List<object?>;
        Assert.NotNull(tags);
        Assert.Equal("node", tags![0]);
        Assert.Equal("ios", tags[1]);
        var meta = result["meta"] as Dictionary<string, object?>;
        Assert.NotNull(meta);
        Assert.Equal(2L, meta!["count"]);
    }
}
