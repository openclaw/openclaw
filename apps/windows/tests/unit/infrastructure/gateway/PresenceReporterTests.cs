using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Gateway;

public sealed class PresenceReporterTests
{
    // ── ComposePresenceSummary ────────────────────────────────────────────────
    // Mirrors Swift: _testComposePresenceSummary(mode:reason:) in DEBUG extension

    [Fact]
    public void ComposePresenceSummary_ContainsMode()
    {
        var summary = PresenceReporter.ComposePresenceSummary("local", "launch");
        Assert.Contains("mode local", summary);
    }

    [Fact]
    public void ComposePresenceSummary_ContainsReason()
    {
        var summary = PresenceReporter.ComposePresenceSummary("remote", "periodic");
        Assert.Contains("reason periodic", summary);
    }

    [Fact]
    public void ComposePresenceSummary_ContainsNodePrefix()
    {
        var summary = PresenceReporter.ComposePresenceSummary("local", "launch");
        Assert.StartsWith("Node:", summary);
    }

    [Fact]
    public void ComposePresenceSummary_ContainsAppVersion()
    {
        var summary = PresenceReporter.ComposePresenceSummary("local", "launch");
        Assert.Contains("app ", summary);
    }

    // ── PlatformString ────────────────────────────────────────────────────────
    // Mirrors Swift: _testPlatformString() — "macos x.y.z" → "windows x.y.z"

    [Fact]
    public void PlatformString_StartsWithWindows()
    {
        Assert.StartsWith("windows ", PresenceReporter.PlatformString());
    }

    [Fact]
    public void PlatformString_ContainsVersionNumbers()
    {
        var platform = PresenceReporter.PlatformString();
        // e.g. "windows 10.0.19041" — must have at least one dot
        Assert.Contains('.', platform);
    }

    // ── AppVersionString ──────────────────────────────────────────────────────
    // Mirrors Swift: _testAppVersionString()

    [Fact]
    public void AppVersionString_IsNonEmpty()
    {
        var version = PresenceReporter.AppVersionString();
        Assert.False(string.IsNullOrWhiteSpace(version));
    }

    // ── PushAsync ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task PushAsync_CallsSendSystemEvent_WithExpectedFields()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        var settings = Substitute.For<ISettingsRepository>();
        settings.LoadAsync(Arg.Any<CancellationToken>())
                .Returns(AppSettings.WithDefaults(Path.GetTempPath()));

        var reporter = new PresenceReporter(rpc, settings, NullLogger<PresenceReporter>.Instance);
        await reporter.PushAsync("launch", CancellationToken.None);

        await rpc.Received(1).SendSystemEventAsync(
            Arg.Is<Dictionary<string, object?>>(d =>
                d.ContainsKey("instanceId") &&
                d.ContainsKey("host") &&
                d.ContainsKey("ip") &&
                d.ContainsKey("mode") &&
                d.ContainsKey("version") &&
                d.ContainsKey("platform") &&
                d.ContainsKey("deviceFamily") &&
                (string?)d["deviceFamily"] == "PC" &&
                d.ContainsKey("reason") &&
                d.ContainsKey("text")),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PushAsync_RpcThrows_DoesNotPropagate()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.SendSystemEventAsync(Arg.Any<Dictionary<string, object?>>(), Arg.Any<CancellationToken>())
           .Returns<Task>(_ => throw new InvalidOperationException("rpc down"));

        var settings = Substitute.For<ISettingsRepository>();
        settings.LoadAsync(Arg.Any<CancellationToken>())
                .Returns(AppSettings.WithDefaults(Path.GetTempPath()));

        var reporter = new PresenceReporter(rpc, settings, NullLogger<PresenceReporter>.Instance);

        // Must not throw
        await reporter.PushAsync("launch", CancellationToken.None);
    }
}
