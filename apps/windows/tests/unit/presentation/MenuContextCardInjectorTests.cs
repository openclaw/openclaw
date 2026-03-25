using NSubstitute;
using OpenClawWindows.Application.Sessions;
using OpenClawWindows.Domain.Sessions;
using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class MenuContextCardInjectorTests
{
    // ── Constants ─────────────────────────────────────────────────────────────

    [Fact]
    public void FallbackCardWidth_Is320()
    {
        Assert.Equal(320.0, MenuContextCardInjector.FallbackCardWidth);
    }

    [Fact]
    public void ActiveWindow_Is24Hours()
    {
        Assert.Equal(TimeSpan.FromDays(1), MenuContextCardInjector.ActiveWindow);
    }

    [Fact]
    public void RefreshInterval_Is15Seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(15), MenuContextCardInjector.RefreshInterval);
    }

    // ── Initial state ─────────────────────────────────────────────────────────

    [Fact]
    public void Initial_CachedRows_IsEmpty()
    {
        var injector = MakeInjector(out _);
        Assert.Empty(injector.CachedRows);
    }

    [Fact]
    public void Initial_CacheErrorText_IsNull()
    {
        var injector = MakeInjector(out _);
        Assert.Null(injector.CacheErrorText);
    }

    // ── OnMenuOpenedAsync — loads when cache is empty ─────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_EmptyCache_LoadsRows()
    {
        var injector = MakeInjector(out var sender);
        var row = MakeRow("main");
        SetupSenderSuccess(sender, [row]);

        await injector.OnMenuOpenedAsync();

        Assert.Single(injector.CachedRows);
        Assert.Equal("main", injector.CachedRows[0].Key);
    }

    // ── Filter — activeWindowSeconds ──────────────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_FiltersOldRows_KeepsMain()
    {
        var injector = MakeInjector(out var sender);
        var now = DateTimeOffset.UtcNow;

        // "main" always included; "old" is older than 24h; "recent" is within 24h.
        var mainRow   = MakeRow("main",   updatedAt: now.AddDays(-2));
        var oldRow    = MakeRow("old",    updatedAt: now.AddSeconds(-(86_400 + 1)));
        var recentRow = MakeRow("recent", updatedAt: now.AddHours(-1));
        SetupSenderSuccess(sender, [mainRow, oldRow, recentRow]);

        await injector.OnMenuOpenedAsync();

        var keys = injector.CachedRows.Select(r => r.Key).ToList();
        Assert.Contains("main",   keys);
        Assert.Contains("recent", keys);
        Assert.DoesNotContain("old", keys);
    }

    // ── Sort — main first, then by updatedAt desc ─────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_SortsMainFirst()
    {
        var injector = MakeInjector(out var sender);
        var now = DateTimeOffset.UtcNow;

        var a = MakeRow("alpha", updatedAt: now.AddHours(-1));
        var m = MakeRow("main",  updatedAt: now.AddDays(-2));
        var b = MakeRow("beta",  updatedAt: now.AddMinutes(-30));
        SetupSenderSuccess(sender, [a, m, b]);

        await injector.OnMenuOpenedAsync();

        Assert.Equal("main",  injector.CachedRows[0].Key);
        Assert.Equal("beta",  injector.CachedRows[1].Key);  // more recent
        Assert.Equal("alpha", injector.CachedRows[2].Key);
    }

    // ── Error path ────────────────────────────────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_GatewayError_SetsErrorText()
    {
        var injector = MakeInjector(out var sender);
        sender.Send(Arg.Any<ListSessionsQuery>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<SessionsSnapshot>>(
                  Error.Failure("ERR", "gateway unavailable")));

        await injector.OnMenuOpenedAsync();

        Assert.Empty(injector.CachedRows);
        Assert.NotNull(injector.CacheErrorText);
    }

    [Fact]
    public async Task OnMenuOpenedAsync_ErrorText_TruncatesAt90Chars()
    {
        var injector = MakeInjector(out var sender);
        var longMsg  = new string('x', 100);
        sender.Send(Arg.Any<ListSessionsQuery>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<SessionsSnapshot>>(
                  Error.Failure("ERR", longMsg)));

        await injector.OnMenuOpenedAsync();

        Assert.NotNull(injector.CacheErrorText);
        Assert.True(injector.CacheErrorText!.Length <= 90);
    }

    // ── RefreshInterval — skips stale refresh ─────────────────────────────────

    [Fact]
    public async Task OnMenuOpenedAsync_CalledTwice_SecondCallSkipsLoad()
    {
        var injector = MakeInjector(out var sender);
        var row = MakeRow("main");
        SetupSenderSuccess(sender, [row]);

        // First open: loads
        await injector.OnMenuOpenedAsync();
        injector.OnMenuClosed();

        // Second open immediately after: cache is fresh (< 15 s), background skip
        await injector.OnMenuOpenedAsync();

        // sender called only once (second open has cache hit → background task, but stale check skips)
        await sender.Received(1).Send(Arg.Any<ListSessionsQuery>(), Arg.Any<CancellationToken>());
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static MenuContextCardInjector MakeInjector(out ISender sender)
    {
        sender = Substitute.For<ISender>();
        return new MenuContextCardInjector(sender);
    }

    private static void SetupSenderSuccess(ISender sender, List<SessionRow> rows)
    {
        var snapshot = new SessionsSnapshot("/path", new SessionDefaults("claude-opus-4-6", 200_000), rows);
        sender.Send(Arg.Any<ListSessionsQuery>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<SessionsSnapshot>>(snapshot));
    }

    private static SessionRow MakeRow(string key, DateTimeOffset? updatedAt = null) =>
        new() { Key = key, UpdatedAt = updatedAt ?? DateTimeOffset.UtcNow };
}
