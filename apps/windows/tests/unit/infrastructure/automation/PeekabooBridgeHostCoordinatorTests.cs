using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Automation;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Automation;

public sealed class PeekabooBridgeHostCoordinatorTests
{
    private static PeekabooBridgeHostCoordinator Make(ISettingsRepository? settings = null)
    {
        if (settings is null)
        {
            var stub = Substitute.For<ISettingsRepository>();
            stub.LoadAsync(Arg.Any<CancellationToken>())
                .Returns(AppSettings.WithDefaults("."));
            settings = stub;
        }
        return new(settings, NullLogger<PeekabooBridgeHostCoordinator>.Instance);
    }

    // ── Constants (mirrors Swift private static properties) ───────────────────

    [Fact]
    public void PipeName_IsOpenClawPeekaboo()
    {
        // Adapts PeekabooBridgeConstants.socketName / "OpenClaw" directory
        Assert.Equal("openclaw-peekaboo", PeekabooBridgeHostCoordinator.PipeName);
    }

    [Fact]
    public void LegacyPipeNames_ContainsAllThreeNames()
    {
        // Mirrors legacySocketDirectoryNames = ["clawdbot", "clawdis", "moltbot"]
        Assert.Contains("clawdbot",  PeekabooBridgeHostCoordinator.LegacyPipeNames);
        Assert.Contains("clawdis",   PeekabooBridgeHostCoordinator.LegacyPipeNames);
        Assert.Contains("moltbot",   PeekabooBridgeHostCoordinator.LegacyPipeNames);
    }

    [Fact]
    public void LegacyPipeNames_HasExactlyThreeEntries()
    {
        Assert.Equal(3, PeekabooBridgeHostCoordinator.LegacyPipeNames.Count);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task StartAsync_DoesNotThrow()
    {
        var coord = Make();
        await coord.StartAsync(CancellationToken.None);
    }

    [Fact]
    public async Task StopAsync_WhenNotRunning_DoesNotThrow()
    {
        var coord = Make();
        await coord.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task SetEnabled_True_ThenFalse_DoesNotThrow()
    {
        var coord = Make();
        await coord.SetEnabledAsync(true);
        await coord.SetEnabledAsync(false);
    }

    [Fact]
    public async Task SetEnabled_TrueTwice_DoesNotThrow()
    {
        // Mirrors guard self.host == nil else { return }
        var coord = Make();
        await coord.SetEnabledAsync(true);
        await coord.SetEnabledAsync(true);
    }

    [Fact]
    public async Task SetEnabled_False_WhenAlreadyStopped_DoesNotThrow()
    {
        var coord = Make();
        await coord.SetEnabledAsync(false);
    }

    // ── Settings-driven startup ───────────────────────────────────────────────

    [Fact]
    public async Task StartAsync_PeekabooBridgeEnabled_True_StartsCoordinator()
    {
        // Mirrors Swift: launch → setEnabled(appSettings.peekabooEnabled == true)
        var settings = Substitute.For<ISettingsRepository>();
        var appSettings = AppSettings.WithDefaults(".");
        // PeekabooBridgeEnabled defaults to true
        settings.LoadAsync(Arg.Any<CancellationToken>()).Returns(appSettings);

        var coord = Make(settings);
        await coord.StartAsync(CancellationToken.None);

        // SetEnabledAsync(true) → StartIfNeededAsync → _running = true; StopAsync should log
        await coord.StopAsync(CancellationToken.None); // exercises the running→stopped path
    }

    [Fact]
    public async Task StartAsync_PeekabooBridgeEnabled_False_DoesNotStart()
    {
        var settings = Substitute.For<ISettingsRepository>();
        var appSettings = AppSettings.WithDefaults(".");
        appSettings.SetPeekabooBridgeEnabled(false);
        settings.LoadAsync(Arg.Any<CancellationToken>()).Returns(appSettings);

        var coord = Make(settings);
        await coord.StartAsync(CancellationToken.None);

        // SetEnabledAsync(false) → stop() → _running stays false; StopAsync is a no-op
        await coord.StopAsync(CancellationToken.None);
    }
}
