using OpenClawWindows.Infrastructure.Paths;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Paths;

[Collection("LogLocator")]
public sealed class LogLocatorTests : IDisposable
{
    private readonly string? _prevLogDir;
    private readonly List<string> _tempDirs = [];

    public LogLocatorTests()
    {
        _prevLogDir = Environment.GetEnvironmentVariable("OPENCLAW_LOG_DIR");
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", null);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", _prevLogDir);
        foreach (var dir in _tempDirs)
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    private string UniqueTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"oc-log-{Guid.NewGuid()}");
        _tempDirs.Add(dir);
        return dir;
    }

    // ── ServiceGatewayLogPath ─────────────────────────────────────────────────

    [Fact]
    public void ServiceGatewayLogPath_EnsuresLogDirExists()
    {
        var logDir = UniqueTempDir();
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", logDir);

        _ = LogLocator.ServiceGatewayLogPath;

        Directory.Exists(logDir).Should().BeTrue();
    }

    [Fact]
    public void ServiceGatewayLogPath_ReturnsGatewayLogUnderLogDir()
    {
        var logDir = UniqueTempDir();
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", logDir);

        LogLocator.ServiceGatewayLogPath.Should().Be(Path.Combine(logDir, "openclaw-gateway.log"));
    }

    // ── ServiceLogPath ────────────────────────────────────────────────────────

    [Fact]
    public void ServiceLogPath_EnsuresLogDirExists()
    {
        var logDir = UniqueTempDir();
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", logDir);

        _ = LogLocator.ServiceLogPath;

        Directory.Exists(logDir).Should().BeTrue();
    }

    [Fact]
    public void ServiceLogPath_ReturnsStdoutLogUnderLogDir()
    {
        var logDir = UniqueTempDir();
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", logDir);

        LogLocator.ServiceLogPath.Should().Be(Path.Combine(logDir, "openclaw-stdout.log"));
    }

    // ── BestLogFile ───────────────────────────────────────────────────────────

    [Fact]
    public void BestLogFile_ReturnsNewestOpenClawLog()
    {
        var logDir = UniqueTempDir();
        Directory.CreateDirectory(logDir);
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", logDir);

        var older = Path.Combine(logDir, "openclaw-old.log");
        var newer = Path.Combine(logDir, "openclaw-gateway.log");
        File.WriteAllText(older, "old");
        File.WriteAllText(newer, "new");
        // Use explicit timestamps to avoid filesystem resolution ambiguity
        File.SetLastWriteTimeUtc(older, DateTime.UtcNow.AddMinutes(-1));
        File.SetLastWriteTimeUtc(newer, DateTime.UtcNow);

        LogLocator.BestLogFile().Should().Be(newer);
    }

    [Fact]
    public void BestLogFile_IgnoresNonOpenClawFiles()
    {
        var logDir = UniqueTempDir();
        Directory.CreateDirectory(logDir);
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", logDir);

        File.WriteAllText(Path.Combine(logDir, "other.log"), "x");
        File.WriteAllText(Path.Combine(logDir, "openclaw-gateway.log"), "x");

        LogLocator.BestLogFile().Should().EndWith("openclaw-gateway.log");
    }

    [Fact]
    public void BestLogFile_IgnoresNonLogExtensions()
    {
        var logDir = UniqueTempDir();
        Directory.CreateDirectory(logDir);
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", logDir);

        File.WriteAllText(Path.Combine(logDir, "openclaw-data.txt"), "x");

        LogLocator.BestLogFile().Should().BeNull();
    }

    [Fact]
    public void BestLogFile_ReturnsNullWhenNoLogsExist()
    {
        var logDir = UniqueTempDir();
        Environment.SetEnvironmentVariable("OPENCLAW_LOG_DIR", logDir);

        LogLocator.BestLogFile().Should().BeNull();
    }
}

[CollectionDefinition("LogLocator", DisableParallelization = true)]
public sealed class LogLocatorCollection;
