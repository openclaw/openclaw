using OpenClawWindows.Infrastructure.Paths;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Paths;

public sealed class RuntimeLocatorTests : IDisposable
{
    private readonly List<string> _tempDirs = [];

    public void Dispose()
    {
        foreach (var dir in _tempDirs)
            if (Directory.Exists(dir))
                Directory.Delete(dir, recursive: true);
    }

    // Creates a temp dir with a node.bat that echoes the given version string
    private string MakeTempNodeBat(string versionOutput)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"oc-rt-{Guid.NewGuid()}");
        Directory.CreateDirectory(dir);
        _tempDirs.Add(dir);
        // @echo off suppresses the command echo; echo writes to stdout
        File.WriteAllText(Path.Combine(dir, "node.bat"), $"@echo off\r\necho {versionOutput}\r\n");
        return dir;
    }

    // ── Resolve ───────────────────────────────────────────────────────────────

    [Fact]
    public void Resolve_SucceedsWithValidNode()
    {
        var dir = MakeTempNodeBat("v22.5.0");
        var result = RuntimeLocator.Resolve(searchPaths: [dir]);

        result.IsSuccess.Should().BeTrue();
        result.Resolution!.Value.Path.Should().Contain("node.bat");
        result.Resolution!.Value.Version.Should().Be(new RuntimeVersion(22, 5, 0));
    }

    [Fact]
    public void Resolve_FailsWhenTooOld()
    {
        var dir = MakeTempNodeBat("v18.2.0");
        var result = RuntimeLocator.Resolve(searchPaths: [dir]);

        result.IsSuccess.Should().BeFalse();
        result.Error.Should().BeOfType<RuntimeResolutionError.Unsupported>();
        var err = (RuntimeResolutionError.Unsupported)result.Error!;
        err.Found.Should().Be(new RuntimeVersion(18, 2, 0));
        err.Path.Should().Contain("node.bat");
    }

    [Fact]
    public void Resolve_FailsWhenVersionUnparsable()
    {
        var dir = MakeTempNodeBat("node-version:unknown");
        var result = RuntimeLocator.Resolve(searchPaths: [dir]);

        result.IsSuccess.Should().BeFalse();
        result.Error.Should().BeOfType<RuntimeResolutionError.VersionParse>();
        var err = (RuntimeResolutionError.VersionParse)result.Error!;
        err.Raw.Should().Contain("unknown");
        err.Path.Should().Contain("node.bat");
    }

    [Fact]
    public void Resolve_FailsWhenNoBinaryFound()
    {
        var emptyDir = Path.Combine(Path.GetTempPath(), $"oc-rt-empty-{Guid.NewGuid()}");
        Directory.CreateDirectory(emptyDir);
        _tempDirs.Add(emptyDir);

        var result = RuntimeLocator.Resolve(searchPaths: [emptyDir]);

        result.IsSuccess.Should().BeFalse();
        result.Error.Should().BeOfType<RuntimeResolutionError.NotFound>();
    }

    // ── DescribeFailure ───────────────────────────────────────────────────────

    [Fact]
    public void DescribeFailure_NotFound_ContainsPaths()
    {
        var msg = RuntimeLocator.DescribeFailure(
            new RuntimeResolutionError.NotFound(["/tmp/a", "/tmp/b"]));

        msg.Should().Contain("PATH searched: /tmp/a;/tmp/b");
        msg.Should().Contain("Node >=22.0.0");
    }

    [Fact]
    public void DescribeFailure_Unsupported_ContainsVersionAndPath()
    {
        var msg = RuntimeLocator.DescribeFailure(
            new RuntimeResolutionError.Unsupported(
                RuntimeKind.Node,
                new RuntimeVersion(18, 2, 0),
                new RuntimeVersion(22, 0, 0),
                "/usr/bin/node",
                ["/usr/bin"]));

        msg.Should().Contain("18.2.0");
        msg.Should().Contain("/usr/bin/node");
        msg.Should().Contain("22.0.0");
    }

    [Fact]
    public void DescribeFailure_VersionParse_ContainsRawAndPath()
    {
        var msg = RuntimeLocator.DescribeFailure(
            new RuntimeResolutionError.VersionParse(
                RuntimeKind.Node,
                "node-version:unknown",
                "/usr/bin/node",
                ["/usr/bin"]));

        msg.Should().Contain("node-version:unknown");
        msg.Should().Contain("/usr/bin/node");
    }

    // ── RuntimeVersion.From ───────────────────────────────────────────────────

    [Theory]
    [InlineData("v22.1.3", 22, 1, 3)]
    [InlineData("node 22.3.0-alpha.1", 22, 3, 0)]
    [InlineData("22.0.0", 22, 0, 0)]
    public void RuntimeVersion_From_ParsesCorrectly(string input, int major, int minor, int patch)
    {
        RuntimeVersion.From(input).Should().Be(new RuntimeVersion(major, minor, patch));
    }

    [Fact]
    public void RuntimeVersion_From_ReturnsNullForBogusString()
    {
        RuntimeVersion.From("bogus").Should().BeNull();
    }

    // ── Comparison ────────────────────────────────────────────────────────────

    [Fact]
    public void RuntimeVersion_Comparison_Works()
    {
        var v18 = new RuntimeVersion(18, 0, 0);
        var v22 = new RuntimeVersion(22, 0, 0);
        (v18 < v22).Should().BeTrue();
        (v22 > v18).Should().BeTrue();
        (v22 >= new RuntimeVersion(22, 0, 0)).Should().BeTrue();
    }
}
