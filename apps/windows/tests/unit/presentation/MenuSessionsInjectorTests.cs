using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Sessions;
using OpenClawWindows.Domain.Sessions;
using OpenClawWindows.Domain.Usage;
using OpenClawWindows.Presentation.Tray;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class MenuSessionsInjectorTests
{
    // ── Constants ─────────────────────────────────────────────────────────────

    [Fact]
    public void FallbackWidth_Is320()
    {
        Assert.Equal(320.0, MenuSessionsInjector.FallbackWidth);
    }

    [Fact]
    public void ActiveWindow_Is24Hours()
    {
        Assert.Equal(TimeSpan.FromDays(1), MenuSessionsInjector.ActiveWindow);
    }

    // ── Initial state ─────────────────────────────────────────────────────────

    [Fact]
    public void Initial_CachedRows_IsEmpty()
    {
        var injector = MakeInjector(out _, out _);
        Assert.Empty(injector.CachedRows);
    }

    [Fact]
    public void Initial_CacheErrorText_IsNull()
    {
        var injector = MakeInjector(out _, out _);
        Assert.Null(injector.CacheErrorText);
    }

    [Fact]
    public void Initial_CachedUsageSummary_IsNull()
    {
        var injector = MakeInjector(out _, out _);
        Assert.Null(injector.CachedUsageSummary);
    }

    [Fact]
    public void Initial_CachedCostSummary_IsNull()
    {
        var injector = MakeInjector(out _, out _);
        Assert.Null(injector.CachedCostSummary);
    }

    // ── Session cache — load on empty ─────────────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_Connected_LoadsSessionRows()
    {
        var injector = MakeInjector(out var sender, out _);
        var row = MakeRow("main");
        SetupSenderSuccess(sender, [row]);

        await injector.OnMenuOpenedAsync(isConnected: true);

        Assert.Single(injector.CachedRows);
        Assert.Equal("main", injector.CachedRows[0].Key);
    }

    [Fact]
    public async Task OnMenuOpenedAsync_NotConnected_EmptyCacheAndNoError()
    {
        var injector = MakeInjector(out var sender, out _);
        sender.Send(Arg.Any<ListSessionsQuery>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<SessionsSnapshot>>(
                  Error.Failure("ERR", "unreachable")));

        await injector.OnMenuOpenedAsync(isConnected: false);

        Assert.Empty(injector.CachedRows);
        Assert.Null(injector.CacheErrorText);
    }

    // ── Session filter — activeWindowSeconds ──────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_FiltersOldRows_KeepsMain()
    {
        var injector = MakeInjector(out var sender, out _);
        var now      = DateTimeOffset.UtcNow;

        var mainRow   = MakeRow("main",   updatedAt: now.AddDays(-2));
        var oldRow    = MakeRow("old",    updatedAt: now.AddSeconds(-(86_400 + 1)));
        var recentRow = MakeRow("recent", updatedAt: now.AddHours(-1));
        SetupSenderSuccess(sender, [mainRow, oldRow, recentRow]);

        await injector.OnMenuOpenedAsync(isConnected: true);

        var keys = injector.CachedRows.Select(r => r.Key).ToList();
        Assert.Contains("main",   keys);
        Assert.Contains("recent", keys);
        Assert.DoesNotContain("old", keys);
    }

    // ── Session sort — main first ──────────────────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_SortsMainFirst()
    {
        var injector = MakeInjector(out var sender, out _);
        var now      = DateTimeOffset.UtcNow;

        var a = MakeRow("alpha", updatedAt: now.AddHours(-1));
        var m = MakeRow("main",  updatedAt: now.AddDays(-2));
        var b = MakeRow("beta",  updatedAt: now.AddMinutes(-30));
        SetupSenderSuccess(sender, [a, m, b]);

        await injector.OnMenuOpenedAsync(isConnected: true);

        Assert.Equal("main",  injector.CachedRows[0].Key);
        Assert.Equal("beta",  injector.CachedRows[1].Key);
        Assert.Equal("alpha", injector.CachedRows[2].Key);
    }

    // ── Session error path ────────────────────────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_GatewayError_SetsErrorText()
    {
        var injector = MakeInjector(out var sender, out _);
        sender.Send(Arg.Any<ListSessionsQuery>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<SessionsSnapshot>>(
                  Error.Failure("ERR", "gateway unavailable")));

        await injector.OnMenuOpenedAsync(isConnected: true);

        Assert.Empty(injector.CachedRows);
        Assert.NotNull(injector.CacheErrorText);
    }

    // ── Disconnected — usage/cost caches not populated ────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_NotConnected_UsageSummaryRemainsNull()
    {
        var injector = MakeInjector(out _, out var rpc);
        rpc.RequestDecodedAsync<GatewayUsageSummary>(
               Arg.Any<string>(), Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(Task.FromResult(new GatewayUsageSummary()));

        await injector.OnMenuOpenedAsync(isConnected: false);

        // Not connected → usage refresh skipped, should not call RPC
        await rpc.DidNotReceive().RequestDecodedAsync<GatewayUsageSummary>(
            Arg.Any<string>(), Arg.Any<Dictionary<string, object?>?>(),
            Arg.Any<int?>(), Arg.Any<CancellationToken>());
        Assert.Null(injector.CachedUsageSummary);
    }

    // ── Connected — usage + cost caches populated ─────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_Connected_PopulatesUsageSummary()
    {
        var injector     = MakeInjector(out var sender, out var rpc);
        var usageSummary = new GatewayUsageSummary();
        SetupSenderSuccess(sender, []);
        rpc.RequestDecodedAsync<GatewayUsageSummary>(
               "usage.status", Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(Task.FromResult(usageSummary));
        rpc.RequestDecodedAsync<GatewayCostUsageSummary>(
               Arg.Any<string>(), Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(Task.FromResult(new GatewayCostUsageSummary()));

        await injector.OnMenuOpenedAsync(isConnected: true);

        Assert.NotNull(injector.CachedUsageSummary);
    }

    [Fact]
    public async Task OnMenuOpenedAsync_Connected_PopulatesCostSummary()
    {
        var injector     = MakeInjector(out var sender, out var rpc);
        var costSummary  = new GatewayCostUsageSummary();
        SetupSenderSuccess(sender, []);
        rpc.RequestDecodedAsync<GatewayUsageSummary>(
               Arg.Any<string>(), Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(Task.FromResult(new GatewayUsageSummary()));
        rpc.RequestDecodedAsync<GatewayCostUsageSummary>(
               "usage.cost", Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(Task.FromResult(costSummary));

        await injector.OnMenuOpenedAsync(isConnected: true);

        Assert.NotNull(injector.CachedCostSummary);
    }

    // ── Cost error — CachedCostErrorText set ──────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_CostRpcThrows_SetsCachedCostErrorText()
    {
        var injector = MakeInjector(out var sender, out var rpc);
        SetupSenderSuccess(sender, []);
        rpc.RequestDecodedAsync<GatewayUsageSummary>(
               Arg.Any<string>(), Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(Task.FromResult(new GatewayUsageSummary()));
        rpc.RequestDecodedAsync<GatewayCostUsageSummary>(
               Arg.Any<string>(), Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns<Task<GatewayCostUsageSummary>>(_ => Task.FromException<GatewayCostUsageSummary>(
               new InvalidOperationException("cost rpc failed")));

        await injector.OnMenuOpenedAsync(isConnected: true);

        Assert.Null(injector.CachedCostSummary);
        Assert.NotNull(injector.CachedCostErrorText);
    }

    // ── CompactUsageError — 90-char truncation ────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_CostRpcThrows_LongMessage_TruncatesTo90()
    {
        var injector = MakeInjector(out var sender, out var rpc);
        SetupSenderSuccess(sender, []);
        rpc.RequestDecodedAsync<GatewayUsageSummary>(
               Arg.Any<string>(), Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns(Task.FromResult(new GatewayUsageSummary()));

        var longMsg = new string('x', 100);
        rpc.RequestDecodedAsync<GatewayCostUsageSummary>(
               Arg.Any<string>(), Arg.Any<Dictionary<string, object?>?>(),
               Arg.Any<int?>(), Arg.Any<CancellationToken>())
           .Returns<Task<GatewayCostUsageSummary>>(_ => Task.FromException<GatewayCostUsageSummary>(
               new InvalidOperationException(longMsg)));

        await injector.OnMenuOpenedAsync(isConnected: true);

        Assert.NotNull(injector.CachedCostErrorText);
        Assert.True(injector.CachedCostErrorText!.Length <= 90);
    }

    // ── Throttle — second open skips reload when cache is fresh ──────────────

    [Fact]
    public async Task OnMenuOpenedAsync_CalledTwice_SecondSkipsSessionLoad()
    {
        var injector = MakeInjector(out var sender, out _);
        var row = MakeRow("main");
        SetupSenderSuccess(sender, [row]);

        await injector.OnMenuOpenedAsync(isConnected: true);
        injector.OnMenuClosed();
        await injector.OnMenuOpenedAsync(isConnected: true);

        // sender called only once (12s throttle)
        await sender.Received(1).Send(Arg.Any<ListSessionsQuery>(), Arg.Any<CancellationToken>());
    }

    // ── OnMenuClosed — cancels load ───────────────────────────────────────────

    [Fact]
    public void OnMenuClosed_AfterOpen_DoesNotThrow()
    {
        var injector = MakeInjector(out _, out _);
        injector.OnMenuClosed(); // called before any open — should be a no-op
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static MenuSessionsInjector MakeInjector(out ISender sender, out IGatewayRpcChannel rpc)
    {
        sender = Substitute.For<ISender>();
        rpc    = Substitute.For<IGatewayRpcChannel>();
        return new MenuSessionsInjector(sender, rpc);
    }

    private static void SetupSenderSuccess(ISender sender, List<SessionRow> rows)
    {
        var snapshot = new SessionsSnapshot(
            "/path", new SessionDefaults("claude-opus-4-6", 200_000), rows);
        sender.Send(Arg.Any<ListSessionsQuery>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<SessionsSnapshot>>(snapshot));
    }

    private static SessionRow MakeRow(string key, DateTimeOffset? updatedAt = null) =>
        new() { Key = key, UpdatedAt = updatedAt ?? DateTimeOffset.UtcNow };
}
