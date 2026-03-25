using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Config;

namespace OpenClawWindows.Tests.Unit.Infrastructure;

public sealed class ConfigStoreTests
{
    private static readonly byte[] EmptyConfigResponse =
        Encoding.UTF8.GetBytes("""{"config":{},"hash":"h1"}""");

    private static byte[] ConfigResponse(string key, string value, string hash = "h1") =>
        Encoding.UTF8.GetBytes($$"""{"config":{"{{key}}":"{{value}}"},"hash":"{{hash}}"}""");

    private static GatewayConnection ConnectedGateway()
    {
        var c = GatewayConnection.Create("openclaw-control-ui");
        c.MarkConnecting();
        c.MarkConnected("main", null, TimeProvider.System);
        return c;
    }

    private static ISettingsRepository SettingsWithMode(ConnectionMode mode)
    {
        var settings = AppSettings.WithDefaults(Path.GetTempPath());
        settings.SetConnectionMode(mode);
        var repo = Substitute.For<ISettingsRepository>();
        repo.LoadAsync(Arg.Any<CancellationToken>()).Returns(settings);
        return repo;
    }

    // Helper that tracks hits via closures
    private static (ConfigStore Store, Func<bool> LocalLoadHit, Func<bool> LocalSaveHit) MakeTracked(
        IGatewayRpcChannel rpc,
        GatewayConnection connection,
        ISettingsRepository settings)
    {
        var loadHit = false;
        var saveHit = false;
        var store = new ConfigStore(
            rpc, connection, settings,
            NullLogger<ConfigStore>.Instance,
            () => { loadHit = true; return []; },
            _ => { saveHit = true; });
        return (store, () => loadHit, () => saveHit);
    }

    // ── Load — remote mode ────────────────────────────────────────────────────
    // Mirrors Swift: "load uses remote in remote mode"

    [Fact]
    public async Task Load_Remote_CallsGateway_NotLocalFile()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(ConfigResponse("remote", "true"));

        var connection = GatewayConnection.Create("openclaw-control-ui"); // Disconnected
        var (store, localLoadHit, _) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Remote));

        var result = await store.LoadAsync();

        // Remote mode calls gateway regardless of connection state
        await rpc.Received().ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>());
        Assert.False(localLoadHit());
        Assert.Equal("true", result["remote"]);
    }

    [Fact]
    public async Task Load_Remote_ReturnsEmpty_WhenGatewayUnavailable()
    {
        // Mirrors Swift: loadFromGateway() ?? [:]
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .ThrowsAsync(new InvalidOperationException("rpc unavailable"));

        var connection = GatewayConnection.Create("openclaw-control-ui");
        var (store, localLoadHit, _) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Remote));

        var result = await store.LoadAsync();

        Assert.Empty(result);
        Assert.False(localLoadHit());
    }

    // ── Load — local mode ─────────────────────────────────────────────────────
    // Mirrors Swift: "load uses local in local mode"

    [Fact]
    public async Task Load_Local_WhenConnected_UsesGateway_NotLocalFile()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(ConfigResponse("gateway", "true"));

        var connection = ConnectedGateway();
        var (store, localLoadHit, _) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Local));

        var result = await store.LoadAsync();

        await rpc.Received().ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>());
        Assert.False(localLoadHit());
        Assert.Equal("true", result["gateway"]);
    }

    [Fact]
    public async Task Load_Local_WhenDisconnected_UsesLocalFile()
    {
        // Mirrors Swift local branch: gateway unavailable → OpenClawConfigFile.loadDict()
        var rpc = Substitute.For<IGatewayRpcChannel>();
        var connection = GatewayConnection.Create("openclaw-control-ui"); // Disconnected
        var (store, localLoadHit, _) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Local));

        await store.LoadAsync();

        await rpc.DidNotReceive().ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>());
        Assert.True(localLoadHit());
    }

    [Fact]
    public async Task Load_Local_WhenGatewayFails_FallsBackToLocalFile()
    {
        // Local mode: gateway connected but config.get throws → fall back to local file
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .ThrowsAsync(new InvalidOperationException("rpc error"));

        var connection = ConnectedGateway();
        var (store, localLoadHit, _) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Local));

        await store.LoadAsync();

        Assert.True(localLoadHit());
    }

    // ── Save — remote mode ────────────────────────────────────────────────────
    // Mirrors Swift: "save routes to remote in remote mode"

    [Fact]
    public async Task Save_Remote_CallsGateway_NotLocalFile()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        // config.get called during lazy-hash-fetch and post-save reload
        rpc.ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(EmptyConfigResponse);
        rpc.RequestRawAsync(Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(),
                            Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns([]);

        var connection = ConnectedGateway();
        var (store, _, localSaveHit) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Remote));

        await store.SaveAsync(new Dictionary<string, object?> { ["remote"] = true });

        await rpc.Received().RequestRawAsync(
            Arg.Is<string>(m => m == "config.set"),
            Arg.Any<Dictionary<string, object?>>(),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
        Assert.False(localSaveHit());
    }

    // ── Save — local mode ─────────────────────────────────────────────────────
    // Mirrors Swift: "save routes to local in local mode"

    [Fact]
    public async Task Save_Local_WhenDisconnected_UsesLocalFile()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        var connection = GatewayConnection.Create("openclaw-control-ui"); // Disconnected
        var (store, _, localSaveHit) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Local));

        await store.SaveAsync(new Dictionary<string, object?> { ["local"] = true });

        await rpc.DidNotReceive().RequestRawAsync(
            Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(),
            Arg.Any<int?>(), Arg.Any<CancellationToken>());
        Assert.True(localSaveHit());
    }

    [Fact]
    public async Task Save_Local_WhenConnected_UsesGateway()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(EmptyConfigResponse);
        rpc.RequestRawAsync(Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(),
                            Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns([]);

        var connection = ConnectedGateway();
        var (store, _, localSaveHit) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Local));

        await store.SaveAsync(new Dictionary<string, object?> { ["local"] = true });

        await rpc.Received().RequestRawAsync(
            Arg.Is<string>(m => m == "config.set"),
            Arg.Any<Dictionary<string, object?>>(),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
        Assert.False(localSaveHit());
    }

    [Fact]
    public async Task Save_Local_WhenGatewayFails_FallsBackToLocalFile()
    {
        // Local mode + gateway error → fall back to local file (no re-throw)
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.ConfigGetAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .ThrowsAsync(new InvalidOperationException("rpc down"));
        rpc.RequestRawAsync(Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(),
                            Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .ThrowsAsync(new InvalidOperationException("rpc down"));

        var connection = ConnectedGateway();
        var (store, _, localSaveHit) = MakeTracked(rpc, connection, SettingsWithMode(ConnectionMode.Local));

        await store.SaveAsync(new Dictionary<string, object?> { ["local"] = true });

        Assert.True(localSaveHit());
    }
}
