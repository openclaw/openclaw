using System.Text.Json;
using OpenClawWindows.Domain.Config;

namespace OpenClawWindows.Tests.Unit.Domain.Config;

// Tests are serialized to avoid env-var cross-contamination between runs.
[Collection("ConfigFile")]
public sealed class OpenClawConfigFileTests : IDisposable
{
    private readonly string _stateDir;
    private readonly string _configPath;
    private readonly string? _prevConfigPath;
    private readonly string? _prevStateDir;

    public OpenClawConfigFileTests()
    {
        _stateDir   = Path.Combine(Path.GetTempPath(), $"openclaw-state-{Guid.NewGuid()}");
        _configPath = Path.Combine(_stateDir, "openclaw.json");

        // Override env vars so all tests operate on isolated temp paths
        _prevConfigPath = Environment.GetEnvironmentVariable("OPENCLAW_CONFIG_PATH");
        _prevStateDir   = Environment.GetEnvironmentVariable("OPENCLAW_STATE_DIR");
        Environment.SetEnvironmentVariable("OPENCLAW_CONFIG_PATH", _configPath);
        Environment.SetEnvironmentVariable("OPENCLAW_STATE_DIR", _stateDir);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("OPENCLAW_CONFIG_PATH", _prevConfigPath);
        Environment.SetEnvironmentVariable("OPENCLAW_STATE_DIR", _prevStateDir);
        if (Directory.Exists(_stateDir))
            Directory.Delete(_stateDir, recursive: true);
    }

    // ── Path resolution ───────────────────────────────────────────────────────

    [Fact]
    public void ConfigPath_RespectsEnvOverride()
        => OpenClawConfigFile.ConfigPath().Should().Be(_configPath);

    [Fact]
    public void StateDirPath_RespectsEnvOverride()
        => OpenClawConfigFile.StateDirPath().Should().Be(_stateDir);

    // ── LoadDict / SaveDict ───────────────────────────────────────────────────

    [Fact]
    public void LoadDict_WhenFileAbsent_ReturnsEmptyDict()
        => OpenClawConfigFile.LoadDict().Should().BeEmpty();

    [Fact]
    public void SaveDict_CreatesFileWithMetaSection()
    {
        OpenClawConfigFile.SaveDict(new() { ["gateway"] = new Dictionary<string, object?> { ["mode"] = "local" } });

        var text = File.ReadAllText(_configPath);
        using var doc = JsonDocument.Parse(text);
        doc.RootElement.TryGetProperty("meta", out _).Should().BeTrue();
    }

    [Fact]
    public void SaveDict_WritesIndentedSortedJson()
    {
        OpenClawConfigFile.SaveDict(new() { ["z"] = "last", ["a"] = "first" });

        var text = File.ReadAllText(_configPath);
        var aIdx = text.IndexOf("\"a\"", StringComparison.Ordinal);
        var zIdx = text.IndexOf("\"z\"", StringComparison.Ordinal);
        aIdx.Should().BeLessThan(zIdx, "keys should be sorted");
        text.Should().Contain("\n", "output should be indented");
    }

    [Fact]
    public void SaveDict_AppendsConfigAuditLog()
    {
        OpenClawConfigFile.SaveDict(new() { ["gateway"] = new Dictionary<string, object?> { ["mode"] = "local" } });

        var auditPath = Path.Combine(_stateDir, "logs", "config-audit.jsonl");
        File.Exists(auditPath).Should().BeTrue();

        var lines = File.ReadAllLines(auditPath)
            .Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        lines.Should().NotBeEmpty();

        using var doc = JsonDocument.Parse(lines[^1]);
        doc.RootElement.GetProperty("source").GetString().Should().Be("windows-openclaw-config-file");
        doc.RootElement.GetProperty("event").GetString().Should().Be("config.write");
        doc.RootElement.GetProperty("result").GetString().Should().Be("success");
        doc.RootElement.GetProperty("configPath").GetString().Should().Be(_configPath);
    }

    [Fact]
    public void RoundTrip_LoadAfterSave_PreservesData()
    {
        var original = new Dictionary<string, object?>
        {
            ["gateway"] = new Dictionary<string, object?> { ["mode"] = "local", ["port"] = (object?)18789L },
        };
        OpenClawConfigFile.SaveDict(original);

        var loaded = OpenClawConfigFile.LoadGatewayDict();
        loaded["mode"].Should().Be("local");
    }

    // ── RemoteGatewayPort ─────────────────────────────────────────────────────

    [Fact]
    public void RemoteGatewayPort_ParsesPortFromUrl()
    {
        OpenClawConfigFile.SaveDict(new()
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["remote"] = new Dictionary<string, object?> { ["url"] = "ws://gateway.ts.net:19999" },
            },
        });

        OpenClawConfigFile.RemoteGatewayPort().Should().Be(19999);
    }

    [Fact]
    public void RemoteGatewayPort_MatchingHost_FullDomain_ReturnsPort()
    {
        SaveRemoteUrl("ws://gateway.ts.net:19999");
        OpenClawConfigFile.RemoteGatewayPort("gateway.ts.net").Should().Be(19999);
    }

    [Fact]
    public void RemoteGatewayPort_MatchingHost_FirstLabel_ReturnsPort()
    {
        SaveRemoteUrl("ws://gateway.ts.net:19999");
        // "gateway" is the first label of "gateway.ts.net" — should match
        OpenClawConfigFile.RemoteGatewayPort("gateway").Should().Be(19999);
    }

    [Fact]
    public void RemoteGatewayPort_MatchingHost_DifferentHost_ReturnsNull()
    {
        SaveRemoteUrl("ws://gateway.ts.net:19999");
        OpenClawConfigFile.RemoteGatewayPort("other.ts.net").Should().BeNull();
    }

    // ── SetRemoteGatewayUrl ───────────────────────────────────────────────────

    [Fact]
    public void SetRemoteGatewayUrl_PreservesExistingScheme()
    {
        OpenClawConfigFile.SaveDict(new()
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["remote"] = new Dictionary<string, object?> { ["url"] = "wss://old-host:111" },
            },
        });

        OpenClawConfigFile.SetRemoteGatewayUrl("new-host", 2222);

        var root   = OpenClawConfigFile.LoadDict();
        var url    = ((root["gateway"] as Dictionary<string, object?>)?["remote"] as Dictionary<string, object?>)?["url"] as string;
        url.Should().Be("wss://new-host:2222");
    }

    [Fact]
    public void SetRemoteGatewayUrl_DefaultsToWsScheme_WhenNoPreviousUrl()
    {
        OpenClawConfigFile.SetRemoteGatewayUrl("myhost", 9999);

        var root = OpenClawConfigFile.LoadDict();
        var url  = ((root["gateway"] as Dictionary<string, object?>)?["remote"] as Dictionary<string, object?>)?["url"] as string;
        url.Should().StartWith("ws://");
    }

    [Fact]
    public void SetRemoteGatewayUrl_ZeroPort_DoesNothing()
    {
        OpenClawConfigFile.SetRemoteGatewayUrl("myhost", 0);
        OpenClawConfigFile.LoadDict().Should().BeEmpty();
    }

    // ── ClearRemoteGatewayUrl ─────────────────────────────────────────────────

    [Fact]
    public void ClearRemoteGatewayUrl_RemovesOnlyUrlField()
    {
        OpenClawConfigFile.SaveDict(new()
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["remote"] = new Dictionary<string, object?>
                {
                    ["url"]   = "wss://old-host:111",
                    ["token"] = "tok",
                },
            },
        });

        OpenClawConfigFile.ClearRemoteGatewayUrl();

        var root   = OpenClawConfigFile.LoadDict();
        var remote = (root["gateway"] as Dictionary<string, object?>)?["remote"] as Dictionary<string, object?>;
        remote.Should().NotBeNull();
        remote!.ContainsKey("url").Should().BeFalse();
        remote["token"].Should().Be("tok");
    }

    // ── HostKey ───────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("gateway.ts.net", "gateway")]
    [InlineData("gateway",        "gateway")]
    [InlineData("192.168.1.1",    "192.168.1.1")]
    [InlineData("::1",            "::1")]
    [InlineData("  MyHost.Local ", "myhost")]
    [InlineData("", "")]
    public void HostKey_NormalizesCorrectly(string input, string expected)
        => OpenClawConfigFile.HostKey(input).Should().Be(expected);

    // ── BrowserControl ────────────────────────────────────────────────────────

    [Fact]
    public void BrowserControlEnabled_DefaultsToTrue_WhenAbsent()
        => OpenClawConfigFile.BrowserControlEnabled().Should().BeTrue();

    [Fact]
    public void SetBrowserControlEnabled_Persists()
    {
        OpenClawConfigFile.SetBrowserControlEnabled(false);
        OpenClawConfigFile.BrowserControlEnabled().Should().BeFalse();
    }

    // ── GatewayPort ───────────────────────────────────────────────────────────

    [Fact]
    public void GatewayPort_ParsesLongFromJson()
    {
        OpenClawConfigFile.SaveDict(new()
        {
            ["gateway"] = new Dictionary<string, object?> { ["port"] = (object?)18789L },
        });
        OpenClawConfigFile.GatewayPort().Should().Be(18789);
    }

    [Fact]
    public void GatewayPort_ParsesStringPort()
    {
        OpenClawConfigFile.SaveDict(new()
        {
            ["gateway"] = new Dictionary<string, object?> { ["port"] = " 9999 " },
        });
        OpenClawConfigFile.GatewayPort().Should().Be(9999);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void SaveRemoteUrl(string url)
    {
        OpenClawConfigFile.SaveDict(new()
        {
            ["gateway"] = new Dictionary<string, object?>
            {
                ["remote"] = new Dictionary<string, object?> { ["url"] = url },
            },
        });
    }
}

[CollectionDefinition("ConfigFile", DisableParallelization = true)]
public sealed class ConfigFileCollection;
