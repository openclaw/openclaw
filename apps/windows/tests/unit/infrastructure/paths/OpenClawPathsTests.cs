using OpenClawWindows.Infrastructure.Paths;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Paths;

[Collection("OpenClawPaths")]
public sealed class OpenClawEnvTests
{
    [Fact]
    public void Path_UnsetVar_ReturnsNull()
    {
        Environment.SetEnvironmentVariable("_OC_TEST_UNSET_", null);
        OpenClawEnv.Path("_OC_TEST_UNSET_").Should().BeNull();
    }

    [Fact]
    public void Path_EmptyVar_ReturnsNull()
    {
        Environment.SetEnvironmentVariable("_OC_TEST_EMPTY_", "");
        OpenClawEnv.Path("_OC_TEST_EMPTY_").Should().BeNull();
    }

    [Fact]
    public void Path_WhitespaceOnly_ReturnsNull()
    {
        Environment.SetEnvironmentVariable("_OC_TEST_WS_", "   ");
        OpenClawEnv.Path("_OC_TEST_WS_").Should().BeNull();
    }

    [Fact]
    public void Path_ValueWithWhitespace_ReturnsTrimmed()
    {
        Environment.SetEnvironmentVariable("_OC_TEST_VAL_", "  /some/path  ");
        OpenClawEnv.Path("_OC_TEST_VAL_").Should().Be("/some/path");
    }
}

[Collection("OpenClawPaths")]
public sealed class OpenClawPathsTests : IDisposable
{
    private readonly string? _prevConfigPath;
    private readonly string? _prevStateDir;

    public OpenClawPathsTests()
    {
        _prevConfigPath = Environment.GetEnvironmentVariable("OPENCLAW_CONFIG_PATH");
        _prevStateDir   = Environment.GetEnvironmentVariable("OPENCLAW_STATE_DIR");
        // Clear overrides so each test starts clean
        Environment.SetEnvironmentVariable("OPENCLAW_CONFIG_PATH", null);
        Environment.SetEnvironmentVariable("OPENCLAW_STATE_DIR",   null);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("OPENCLAW_CONFIG_PATH", _prevConfigPath);
        Environment.SetEnvironmentVariable("OPENCLAW_STATE_DIR",   _prevStateDir);
    }

    // ── StateDirPath ──────────────────────────────────────────────────────────

    [Fact]
    public void StateDirPath_NoOverride_ContainsOpenClaw()
        => OpenClawPaths.StateDirPath.Should().Contain("OpenClaw");

    [Fact]
    public void StateDirPath_WithEnvOverride_ReturnsOverride()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"oc-state-{Guid.NewGuid()}");
        Environment.SetEnvironmentVariable("OPENCLAW_STATE_DIR", dir);

        OpenClawPaths.StateDirPath.Should().Be(dir);
    }

    // ── ConfigPath ────────────────────────────────────────────────────────────

    [Fact]
    public void ConfigPath_WithEnvOverride_ReturnsOverride()
    {
        var path = Path.Combine(Path.GetTempPath(), $"oc-cfg-{Guid.NewGuid()}.json");
        Environment.SetEnvironmentVariable("OPENCLAW_CONFIG_PATH", path);

        OpenClawPaths.ConfigPath.Should().Be(path);
    }

    [Fact]
    public void ConfigPath_NoOverride_NoExistingFile_FallsBackToStateDirJson()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"oc-state-{Guid.NewGuid()}");
        Environment.SetEnvironmentVariable("OPENCLAW_STATE_DIR", dir);

        OpenClawPaths.ConfigPath.Should().Be(Path.Combine(dir, "openclaw.json"));
    }

    [Fact]
    public void ConfigPath_NoOverride_ExistingFile_ResolvesToExistingFile()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"oc-state-{Guid.NewGuid()}");
        Directory.CreateDirectory(dir);
        var existing = Path.Combine(dir, "openclaw.json");
        File.WriteAllText(existing, "{}");
        try
        {
            Environment.SetEnvironmentVariable("OPENCLAW_STATE_DIR", dir);
            OpenClawPaths.ConfigPath.Should().Be(existing);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // ── WorkspacePath ─────────────────────────────────────────────────────────

    [Fact]
    public void WorkspacePath_IsInsideStateDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"oc-state-{Guid.NewGuid()}");
        Environment.SetEnvironmentVariable("OPENCLAW_STATE_DIR", dir);

        OpenClawPaths.WorkspacePath.Should().Be(Path.Combine(dir, "workspace"));
    }
}

[CollectionDefinition("OpenClawPaths", DisableParallelization = true)]
public sealed class OpenClawPathsCollection;
