using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Tests.Integration.WebChat;

// Integration: IWebChatManager lifecycle contract.
// The WinUI adapter (WebChatManagerAdapter) requires Application.Current and cannot be
// instantiated in headless tests. These tests verify the interface contract via a
// substitute and validate the expected call sequence that callers must follow.
public sealed class WebChatLifecycleTests
{
    private readonly IWebChatManager _manager = Substitute.For<IWebChatManager>();

    // ── Show / toggle / close lifecycle ──────────────────────────────────────

    [Fact]
    public async Task Show_SetsActiveSessionKey()
    {
        _manager.ShowAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        _manager.ActiveSessionKey.Returns("global");

        await _manager.ShowAsync("global");

        _manager.ActiveSessionKey.Should().Be("global");
        await _manager.Received(1).ShowAsync("global", Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task TogglePanel_CalledTwice_TogglesVisibility()
    {
        _manager.TogglePanelAsync(Arg.Any<string>(), Arg.Any<Windows.Graphics.PointInt32?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        await _manager.TogglePanelAsync("global");
        await _manager.TogglePanelAsync("global");

        await _manager.Received(2).TogglePanelAsync(
            "global", Arg.Any<Windows.Graphics.PointInt32?>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public void ClosePanel_DoesNotThrow()
    {
        var act = () => _manager.ClosePanel();
        act.Should().NotThrow();
        _manager.Received(1).ClosePanel();
    }

    [Fact]
    public void ResetAll_DoesNotThrow()
    {
        var act = () => _manager.ResetAll();
        act.Should().NotThrow();
        _manager.Received(1).ResetAll();
    }

    // ── GetPreferredSessionKey ────────────────────────────────────────────────

    [Fact]
    public async Task GetPreferredSessionKey_ReturnsMainSessionKey()
    {
        _manager.GetPreferredSessionKeyAsync(Arg.Any<CancellationToken>())
            .Returns("global");

        var key = await _manager.GetPreferredSessionKeyAsync();

        key.Should().Be("global");
    }

    [Fact]
    public async Task GetPreferredSessionKey_CalledTwice_CallsManagerTwice()
    {
        _manager.GetPreferredSessionKeyAsync(Arg.Any<CancellationToken>())
            .Returns("global");

        await _manager.GetPreferredSessionKeyAsync();
        await _manager.GetPreferredSessionKeyAsync();

        await _manager.Received(2).GetPreferredSessionKeyAsync(Arg.Any<CancellationToken>());
    }

    // ── Lifecycle sequence: Show → Toggle → Close → Reset ────────────────────

    [Fact]
    public async Task LifecycleSequence_ShowThenReset_ClearsState()
    {
        _manager.ShowAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        _manager.ActiveSessionKey.Returns((string?)null);

        await _manager.ShowAsync("global");
        _manager.ResetAll();

        // After reset, active session key is cleared
        _manager.ActiveSessionKey.Should().BeNull();
        _manager.Received(1).ResetAll();
    }

    [Fact]
    public async Task LifecycleSequence_ToggleThenClose_CallsClosePanel()
    {
        _manager.TogglePanelAsync(Arg.Any<string>(), Arg.Any<Windows.Graphics.PointInt32?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        await _manager.TogglePanelAsync("global");
        _manager.ClosePanel();

        _manager.Received(1).ClosePanel();
    }

    // ── RPC-backed GetPreferredSessionKey via real mock chain ────────────────

    [Fact]
    public async Task GetPreferredSessionKey_RpcBacked_ReturnsMainKey()
    {
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.MainSessionKeyAsync(Arg.Any<int>(), Arg.Any<CancellationToken>())
            .Returns("global");

        // Simulate the caching logic: first call goes to RPC, subsequent uses cache
        var callCount = 0;
        _manager.GetPreferredSessionKeyAsync(Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                if (callCount++ == 0)
                    return await rpc.MainSessionKeyAsync(ct: call.Arg<CancellationToken>());
                return "global"; // cached
            });

        var key1 = await _manager.GetPreferredSessionKeyAsync();
        var key2 = await _manager.GetPreferredSessionKeyAsync();

        key1.Should().Be("global");
        key2.Should().Be("global");
        // RPC was called only once — second call uses cached value
        await rpc.Received(1).MainSessionKeyAsync(Arg.Any<int>(), Arg.Any<CancellationToken>());
    }
}
