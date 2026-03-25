using OpenClawWindows.Infrastructure.Catalog;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Catalog;

public sealed class ModelCatalogLoaderTests : IDisposable
{
    private readonly string _tmpDir;

    public ModelCatalogLoaderTests()
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), "ocw-modelcatalog-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tmpDir);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tmpDir))
            Directory.Delete(_tmpDir, recursive: true);
    }

    private string WriteTmp(string content)
    {
        var path = Path.Combine(_tmpDir, $"models-{Guid.NewGuid():N}.js");
        File.WriteAllText(path, content);
        return path;
    }

    [Fact]
    public async Task LoadAsync_ParsesModelsAndSorts()
    {
        const string src = """
        export const MODELS = {
          openai: {
            "gpt-4o-mini": { name: "GPT-4o mini", contextWindow: 128000 } satisfies any,
            "gpt-4o": { name: "GPT-4o", contextWindow: 128000 } as any,
            "gpt-3.5": { contextWindow: 16000 },
          },
          anthropic: {
            "claude-3": { name: "Claude 3", contextWindow: 200000 },
          },
        };
        """;

        var path = WriteTmp(src);
        var choices = await ModelCatalogLoader.LoadAsync(path);

        choices.Should().HaveCount(4);
        choices[0].Provider.Should().Be("anthropic");
        choices[0].Id.Should().Be("claude-3");

        var ids = choices.Select(c => c.Id).ToHashSet();
        ids.Should().BeEquivalentTo("claude-3", "gpt-4o", "gpt-4o-mini", "gpt-3.5");

        var openaiNames = choices.Where(c => c.Provider == "openai").Select(c => c.Name).ToList();
        openaiNames.Should().BeInAscendingOrder(StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task LoadAsync_NoExportConst_ReturnsEmpty()
    {
        var path = WriteTmp("const NOPE = 1;");
        var choices = await ModelCatalogLoader.LoadAsync(path);
        choices.Should().BeEmpty();
    }

    [Fact]
    public async Task LoadAsync_MissingName_FallsBackToId()
    {
        const string src = """
        export const MODELS = {
          openai: {
            "gpt-99": { contextWindow: 99000 },
          },
        };
        """;
        var path = WriteTmp(src);
        var choices = await ModelCatalogLoader.LoadAsync(path);
        choices.Should().ContainSingle();
        choices[0].Name.Should().Be("gpt-99");
    }

    [Fact]
    public async Task LoadAsync_ContextWindowIsPreserved()
    {
        const string src = """
        export const MODELS = {
          anthropic: {
            "claude-3-opus": { name: "Claude 3 Opus", contextWindow: 200000 },
          },
        };
        """;
        var path = WriteTmp(src);
        var choices = await ModelCatalogLoader.LoadAsync(path);
        choices[0].ContextWindow.Should().Be(200000);
    }

    // --- Sanitize ---

    [Fact]
    public void Sanitize_StripsTypeScriptSatisfies()
    {
        const string src = """
        export const MODELS = {
          openai: {
            "gpt-4o": { name: "GPT-4o" } satisfies ModelSpec,
          },
        };
        """;
        var result = ModelCatalogLoader.Sanitize(src);
        result.Should().NotContain("satisfies");
        result.Should().StartWith("var MODELS = ");
    }

    [Fact]
    public void Sanitize_StripsTypeScriptAs()
    {
        const string src = """
        export const MODELS = {
          openai: {
            "gpt-4o": { name: "GPT-4o" } as ModelSpec,
          },
        };
        """;
        var result = ModelCatalogLoader.Sanitize(src);
        result.Should().NotContain(" as ModelSpec");
        result.Should().StartWith("var MODELS = ");
    }

    [Fact]
    public void Sanitize_NoExport_ReturnsEmptyModels()
    {
        ModelCatalogLoader.Sanitize("const NOPE = 1;").Should().Be("var MODELS = {}");
    }
}
