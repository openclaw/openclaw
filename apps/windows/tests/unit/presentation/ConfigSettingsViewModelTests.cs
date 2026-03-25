using System.Text.Json;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.Config;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class ConfigSettingsViewModelTests
{
    private static ConfigSettingsViewModel MakeVm(
        out IGatewayRpcChannel rpc,
        out IConfigStore configStore)
    {
        rpc         = Substitute.For<IGatewayRpcChannel>();
        configStore = Substitute.For<IConfigStore>();
        return new ConfigSettingsViewModel(rpc, configStore);
    }

    // ── Construction ─────────────────────────────────────────────────────────

    [Fact]
    public void Ctor_DefaultState()
    {
        var vm = MakeVm(out _, out _);

        vm.ConfigSchemaLoading.Should().BeFalse();
        vm.ConfigSchema.Should().BeNull();
        vm.ConfigDirty.Should().BeFalse();
        vm.ConfigLoaded.Should().BeFalse();
        vm.IsSavingConfig.Should().BeFalse();
        vm.ConfigStatus.Should().BeNull();
    }

    // ── LoadConfigSchemaAsync ─────────────────────────────────────────────────

    [Fact]
    public async Task LoadConfigSchema_ParsesSchemaAndHints()
    {
        var vm = MakeVm(out var rpc, out _);
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema   = new { type = "object", properties = new { foo = new { type = "string" } } },
            uihints  = new { foo = new { label = "Foo Label", order = 1 } },
            version  = "1",
            generatedat = "2026-01-01"
        });
        rpc.RequestRawAsync("config.schema", Arg.Any<Dictionary<string, object?>>(), 8000, Arg.Any<CancellationToken>())
           .Returns(Task.FromResult(payload));

        await vm.LoadConfigSchemaAsync();

        vm.ConfigSchema.Should().NotBeNull();
        vm.ConfigSchema!.SchemaType.Should().Be("object");
        vm.ConfigUiHints.Should().ContainKey("foo");
        vm.ConfigUiHints["foo"].Label.Should().Be("Foo Label");
    }

    [Fact]
    public async Task LoadConfigSchema_SetsStatus_OnError()
    {
        var vm = MakeVm(out var rpc, out _);
        rpc.RequestRawAsync(Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(),
                            Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns<byte[]>(_ => throw new InvalidOperationException("gateway down"));

        await vm.LoadConfigSchemaAsync();

        vm.ConfigStatus.Should().Be("gateway down");
        vm.ConfigSchema.Should().BeNull();
        vm.ConfigSchemaLoading.Should().BeFalse(); // guard resets even on error
    }

    [Fact]
    public async Task LoadConfigSchema_Guard_SkipsIfAlreadyLoading()
    {
        var vm  = MakeVm(out var rpc, out _);
        var tcs = new TaskCompletionSource<byte[]>();
        rpc.RequestRawAsync(Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(),
                            Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(tcs.Task);

        var first  = vm.LoadConfigSchemaAsync(); // starts, blocks
        var second = vm.LoadConfigSchemaAsync(); // should be a no-op
        tcs.SetResult(JsonSerializer.SerializeToUtf8Bytes(new { schema = new { type = "object" }, uihints = new { } }));
        await first;
        await second;

        // Only one RPC call regardless of two invocations
        await rpc.Received(1).RequestRawAsync(
            Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(),
            Arg.Any<int?>(), Arg.Any<CancellationToken>());
    }

    // ── LoadConfigAsync ───────────────────────────────────────────────────────

    [Fact]
    public async Task LoadConfig_SetsLoadedAndClearsDirty()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?> { ["k"] = "v" }));

        await vm.LoadConfigAsync();

        vm.ConfigLoaded.Should().BeTrue();
        vm.ConfigDirty.Should().BeFalse();
        vm.ConfigStatus.Should().BeNull();
        vm.ConfigDraft.Should().ContainKey("k");
    }

    [Fact]
    public async Task LoadConfig_SetsStatus_OnError()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns<Dictionary<string, object?>>(_ => throw new InvalidOperationException("read fail"));

        await vm.LoadConfigAsync();

        vm.ConfigStatus.Should().Be("read fail");
        vm.ConfigLoaded.Should().BeFalse();
    }

    // ── SaveConfigDraftAsync ──────────────────────────────────────────────────

    [Fact]
    public async Task SaveConfigDraft_SavesThenReloads()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?>()));
        store.SaveAsync(Arg.Any<Dictionary<string, object?>>(), Arg.Any<CancellationToken>())
             .Returns(Task.CompletedTask);

        await vm.SaveConfigDraftAsync();

        await store.Received(1).SaveAsync(Arg.Any<Dictionary<string, object?>>(), Arg.Any<CancellationToken>());
        await store.Received(1).LoadAsync(Arg.Any<CancellationToken>());
        vm.IsSavingConfig.Should().BeFalse();
    }

    [Fact]
    public async Task SaveConfigDraft_Guard_SkipsIfAlreadySaving()
    {
        var vm  = MakeVm(out _, out var store);
        var tcs = new TaskCompletionSource();
        store.SaveAsync(Arg.Any<Dictionary<string, object?>>(), Arg.Any<CancellationToken>())
             .Returns(tcs.Task);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?>()));

        var first  = vm.SaveConfigDraftAsync(); // blocks on save
        var second = vm.SaveConfigDraftAsync(); // guard skips
        tcs.SetResult();
        await first;
        await second;

        await store.Received(1).SaveAsync(Arg.Any<Dictionary<string, object?>>(), Arg.Any<CancellationToken>());
    }

    // ── ReloadConfigDraftAsync ────────────────────────────────────────────────

    [Fact]
    public async Task ReloadConfigDraft_DelegatesToLoadConfig()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?> { ["x"] = 1L }));

        await vm.ReloadConfigDraftAsync();

        vm.ConfigLoaded.Should().BeTrue();
        vm.ConfigDraft.Should().ContainKey("x");
    }

    // ── ConfigValueAt / UpdateConfigValue ─────────────────────────────────────

    [Fact]
    public async Task ConfigValueAt_ReturnsValueAtPath()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?>
             {
                 ["section"] = new Dictionary<string, object?> { ["key"] = "hello" }
             }));
        await vm.LoadConfigAsync();

        var path = new List<ConfigPathSegment>
            { new ConfigPathSegment.Key("section"), new ConfigPathSegment.Key("key") };

        vm.ConfigValueAt(path).Should().Be("hello");
    }

    [Fact]
    public async Task UpdateConfigValue_SetsDirtyAndUpdatesDraft()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?> { ["a"] = "old" }));
        await vm.LoadConfigAsync();

        var path = new List<ConfigPathSegment> { new ConfigPathSegment.Key("a") };
        vm.UpdateConfigValue(path, "new");

        vm.ConfigDirty.Should().BeTrue();
        vm.ConfigValueAt(path).Should().Be("new");
    }

    [Fact]
    public async Task UpdateConfigValue_NullRemovesKey()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?> { ["a"] = "value" }));
        await vm.LoadConfigAsync();

        var path = new List<ConfigPathSegment> { new ConfigPathSegment.Key("a") };
        vm.UpdateConfigValue(path, null);

        vm.ConfigValueAt(path).Should().BeNull();
        vm.ConfigDraft.Should().NotContainKey("a");
    }

    [Fact]
    public async Task DeepClone_MutatingDraftDoesNotAffectRoot()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?>
             {
                 ["nested"] = new Dictionary<string, object?> { ["v"] = "original" }
             }));
        await vm.LoadConfigAsync();

        var path = new List<ConfigPathSegment>
            { new ConfigPathSegment.Key("nested"), new ConfigPathSegment.Key("v") };
        vm.UpdateConfigValue(path, "modified");

        // Draft changed
        vm.ConfigValueAt(path).Should().Be("modified");

        // Reload resets draft from store (root was not mutated)
        await vm.LoadConfigAsync();
        vm.ConfigValueAt(path).Should().Be("original");
    }
}
