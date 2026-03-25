using System.Text.Json;
using OpenClawWindows.Infrastructure.Config;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Config;

public sealed class ConfigSchemaSupportTests
{
    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

    // --- ConfigSchemaNode: TypeList / SchemaType ---

    [Fact]
    public void TypeList_SingleString_ReturnsSingleItem()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":"string"}"""))!;
        node.TypeList.Should().Equal("string");
        node.SchemaType.Should().Be("string");
    }

    [Fact]
    public void TypeList_Array_ReturnsAll()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":["string","null"]}"""))!;
        node.TypeList.Should().Equal("string", "null");
    }

    [Fact]
    public void SchemaType_SkipsNull_ReturnsFirstNonNull()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":["null","string"]}"""))!;
        node.SchemaType.Should().Be("string");
    }

    [Fact]
    public void IsNullSchema_TrueWhenOnlyNull()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":["null"]}"""))!;
        node.IsNullSchema.Should().BeTrue();
    }

    [Fact]
    public void IsNullSchema_FalseWhenOtherTypesPresent()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":["null","string"]}"""))!;
        node.IsNullSchema.Should().BeFalse();
    }

    // --- Properties ---

    [Fact]
    public void Properties_ReturnsParsedChildNodes()
    {
        var node = ConfigSchemaNode.Create(Parse("""
        {"type":"object","properties":{"foo":{"type":"string"},"bar":{"type":"integer"}}}
        """))!;
        node.Properties.Should().ContainKey("foo");
        node.Properties["foo"].SchemaType.Should().Be("string");
        node.Properties["bar"].SchemaType.Should().Be("integer");
    }

    // --- RequiredKeys ---

    [Fact]
    public void RequiredKeys_ReturnsSetFromSchema()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"required":["a","b"]}"""))!;
        node.RequiredKeys.Should().BeEquivalentTo("a", "b");
    }

    [Fact]
    public void RequiredKeys_AbsentKey_ReturnsEmpty()
    {
        var node = ConfigSchemaNode.Create(Parse("{}"))!;
        node.RequiredKeys.Should().BeEmpty();
    }

    // --- LiteralValue ---

    [Fact]
    public void LiteralValue_FromConst()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"const":"fixed"}"""))!;
        node.LiteralValue!.Value.GetString().Should().Be("fixed");
    }

    [Fact]
    public void LiteralValue_FromSingleEnum()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"enum":["only"]}"""))!;
        node.LiteralValue!.Value.GetString().Should().Be("only");
    }

    [Fact]
    public void LiteralValue_MultipleEnum_ReturnsNull()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"enum":["a","b"]}"""))!;
        node.LiteralValue.Should().BeNull();
    }

    // --- DefaultValue ---

    [Fact]
    public void DefaultValue_UsesExplicitDefault()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":"string","default":"hello"}"""))!;
        ((JsonElement)node.DefaultValue).GetString().Should().Be("hello");
    }

    [Fact]
    public void DefaultValue_Object_ReturnsEmptyDict()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":"object"}"""))!;
        node.DefaultValue.Should().BeOfType<Dictionary<string, object>>();
    }

    [Fact]
    public void DefaultValue_Boolean_ReturnsFalse()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":"boolean"}"""))!;
        node.DefaultValue.Should().Be(false);
    }

    [Fact]
    public void DefaultValue_Integer_ReturnsZero()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":"integer"}"""))!;
        node.DefaultValue.Should().Be(0);
    }

    // --- Items ---

    [Fact]
    public void Items_ArrayItems_ReturnsFirstElement()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":"array","items":[{"type":"string"}]}"""))!;
        node.Items!.SchemaType.Should().Be("string");
    }

    [Fact]
    public void Items_ObjectItems_ReturnsNode()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":"array","items":{"type":"number"}}"""))!;
        node.Items!.SchemaType.Should().Be("number");
    }

    // --- AllowsAdditionalProperties ---

    [Fact]
    public void AllowsAdditionalProperties_TrueWhenBoolTrue()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"additionalProperties":true}"""))!;
        node.AllowsAdditionalProperties.Should().BeTrue();
    }

    [Fact]
    public void AllowsAdditionalProperties_FalseWhenBoolFalse()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"additionalProperties":false}"""))!;
        node.AllowsAdditionalProperties.Should().BeFalse();
    }

    [Fact]
    public void AllowsAdditionalProperties_TrueWhenSchemaObject()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"additionalProperties":{"type":"string"}}"""))!;
        node.AllowsAdditionalProperties.Should().BeTrue();
    }

    // --- NodeAt traversal ---

    [Fact]
    public void NodeAt_TraversesKeyPath()
    {
        var node = ConfigSchemaNode.Create(Parse("""
        {"type":"object","properties":{"user":{"type":"object","properties":{"name":{"type":"string"}}}}}
        """))!;

        var path = new List<ConfigPathSegment>
        {
            new ConfigPathSegment.Key("user"),
            new ConfigPathSegment.Key("name"),
        };
        node.NodeAt(path)!.SchemaType.Should().Be("string");
    }

    [Fact]
    public void NodeAt_IndexFollowsItems()
    {
        var node = ConfigSchemaNode.Create(Parse("""
        {"type":"array","items":{"type":"boolean"}}
        """))!;

        var path = new List<ConfigPathSegment> { new ConfigPathSegment.Index(0) };
        node.NodeAt(path)!.SchemaType.Should().Be("boolean");
    }

    [Fact]
    public void NodeAt_MissingKey_ReturnsNull()
    {
        var node = ConfigSchemaNode.Create(Parse("""{"type":"object","properties":{}}"""))!;
        var path = new List<ConfigPathSegment> { new ConfigPathSegment.Key("missing") };
        node.NodeAt(path).Should().BeNull();
    }

    [Fact]
    public void NodeAt_AdditionalPropertiesFallback()
    {
        var node = ConfigSchemaNode.Create(Parse("""
        {"type":"object","additionalProperties":{"type":"number"}}
        """))!;
        var path = new List<ConfigPathSegment> { new ConfigPathSegment.Key("anyKey") };
        node.NodeAt(path)!.SchemaType.Should().Be("number");
    }

    // --- ConfigSchemaNode.Create ---

    [Fact]
    public void Create_NonObject_ReturnsNull()
    {
        ConfigSchemaNode.Create(Parse("\"string value\"")).Should().BeNull();
        ConfigSchemaNode.Create(Parse("42")).Should().BeNull();
    }

    // --- ConfigUiHint ---

    [Fact]
    public void ConfigUiHint_ParsesAllFields()
    {
        var hint = new ConfigUiHint(Parse("""
        {"label":"My Label","help":"Some help","order":2.5,"advanced":true,"sensitive":false,"placeholder":"e.g."}
        """));
        hint.Label.Should().Be("My Label");
        hint.Help.Should().Be("Some help");
        hint.Order.Should().Be(2.5);
        hint.Advanced.Should().BeTrue();
        hint.Sensitive.Should().BeFalse();
        hint.Placeholder.Should().Be("e.g.");
    }

    [Fact]
    public void ConfigUiHint_OrderFromInt_IsConverted()
    {
        var hint = new ConfigUiHint(Parse("""{"order":3}"""));
        hint.Order.Should().Be(3.0);
    }

    [Fact]
    public void ConfigUiHint_MissingFields_AreNull()
    {
        var hint = new ConfigUiHint(Parse("{}"));
        hint.Label.Should().BeNull();
        hint.Order.Should().BeNull();
    }

    // --- DecodeUiHints ---

    [Fact]
    public void DecodeUiHints_ParsesAllEntries()
    {
        var hints = ConfigSchemaFunctions.DecodeUiHints(Parse("""
        {"key1":{"label":"K1"},"key2":{"label":"K2"}}
        """));
        hints.Should().ContainKey("key1");
        hints["key1"].Label.Should().Be("K1");
        hints.Should().ContainKey("key2");
    }

    // --- PathKey ---

    [Fact]
    public void PathKey_JoinsKeySegmentsDotSeparated()
    {
        var path = new List<ConfigPathSegment>
        {
            new ConfigPathSegment.Key("agents"),
            new ConfigPathSegment.Index(0),
            new ConfigPathSegment.Key("name"),
        };
        ConfigSchemaFunctions.PathKey(path).Should().Be("agents.name");
    }

    // --- HintForPath ---

    [Fact]
    public void HintForPath_DirectMatchReturnsHint()
    {
        var hints = new Dictionary<string, ConfigUiHint>
        {
            ["agents.name"] = new ConfigUiHint(Parse("""{"label":"Name"}""")),
        };
        var path = new List<ConfigPathSegment>
        {
            new ConfigPathSegment.Key("agents"),
            new ConfigPathSegment.Key("name"),
        };
        ConfigSchemaFunctions.HintForPath(path, hints)!.Label.Should().Be("Name");
    }

    [Fact]
    public void HintForPath_WildcardMatchReturnsHint()
    {
        var hints = new Dictionary<string, ConfigUiHint>
        {
            ["agents.*.name"] = new ConfigUiHint(Parse("""{"label":"Agent Name"}""")),
        };
        var path = new List<ConfigPathSegment>
        {
            new ConfigPathSegment.Key("agents"),
            new ConfigPathSegment.Key("abc"),
            new ConfigPathSegment.Key("name"),
        };
        ConfigSchemaFunctions.HintForPath(path, hints)!.Label.Should().Be("Agent Name");
    }

    [Fact]
    public void HintForPath_NoMatch_ReturnsNull()
    {
        var hints = new Dictionary<string, ConfigUiHint>();
        var path = new List<ConfigPathSegment> { new ConfigPathSegment.Key("missing") };
        ConfigSchemaFunctions.HintForPath(path, hints).Should().BeNull();
    }

    // --- IsSensitivePath ---

    [Theory]
    [InlineData("api.token")]
    [InlineData("auth.password")]
    [InlineData("auth.secret")]
    [InlineData("apikey")]
    [InlineData("private.apiKey")]
    public void IsSensitivePath_TrueForSensitiveKeys(string pathStr)
    {
        var path = pathStr.Split('.').Select(s => (ConfigPathSegment)new ConfigPathSegment.Key(s)).ToList();
        ConfigSchemaFunctions.IsSensitivePath(path).Should().BeTrue();
    }

    [Fact]
    public void IsSensitivePath_FalseForRegularKey()
    {
        var path = new List<ConfigPathSegment> { new ConfigPathSegment.Key("username") };
        ConfigSchemaFunctions.IsSensitivePath(path).Should().BeFalse();
    }
}
