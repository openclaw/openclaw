using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Gateway;

public sealed class RemoteTunnelManagerTests
{
    private static RemoteTunnelManager Make(IRemoteTunnelService tunnel) =>
        new(NullLogger<RemoteTunnelManager>.Instance, tunnel);

    // ── EnsureControlTunnelAsync — reuse active tunnel ────────────────────────

    [Fact]
    public async Task EnsureControlTunnel_WhenAlreadyConnected_ReturnsCachedPort()
    {
        // Swift: if let local = await self.controlTunnelPortIfRunning() { return local }
        // First call: IsConnected=false → ConnectAsync is called, port is cached.
        // Second call: IsConnected=true → ConnectAsync is NOT called again (reuse).
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.IsConnected.Returns(false, true); // false on first read, true on subsequent
        tunnel.ConnectAsync(Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));

        using var mgr = Make(tunnel);
        await mgr.EnsureControlTunnelAsync("user@host", 18789, CancellationToken.None); // connects
        var result = await mgr.EnsureControlTunnelAsync("user@host", 18789, CancellationToken.None); // reuse

        Assert.False(result.IsError);
        Assert.Equal(18789, result.Value);
        // ConnectAsync called only once (on the first call, not the second)
        await tunnel.Received(1).ConnectAsync(
            Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>());
    }

    // ── EnsureControlTunnelAsync — connect when not running ───────────────────

    [Fact]
    public async Task EnsureControlTunnel_WhenNotConnected_CallsConnectAsync()
    {
        // Swift: await RemotePortTunnel.create(…) → ConnectAsync
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.IsConnected.Returns(false);
        tunnel.ConnectAsync(Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));

        using var mgr = Make(tunnel);
        var result = await mgr.EnsureControlTunnelAsync("user@host", 18789, CancellationToken.None);

        Assert.False(result.IsError);
        Assert.Equal(18789, result.Value);
        await tunnel.Received(1).ConnectAsync("user@host", 18789, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task EnsureControlTunnel_WhenConnectFails_ReturnsError()
    {
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.IsConnected.Returns(false);
        tunnel.ConnectAsync(Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<Success>>(Error.Failure("SSH.ERROR", "fail")));

        using var mgr = Make(tunnel);
        var result = await mgr.EnsureControlTunnelAsync("user@host", 18789, CancellationToken.None);

        Assert.True(result.IsError);
    }

    // ── StopAllAsync ──────────────────────────────────────────────────────────

    [Fact]
    public async Task StopAll_CallsDisconnectAsync()
    {
        // Swift: stopAll() → controlTunnel?.terminate()
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.DisconnectAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);

        using var mgr = Make(tunnel);
        await mgr.StopAllAsync();

        await tunnel.Received(1).DisconnectAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task StopAll_ResetsPort_SoNextCallReconnects()
    {
        // After StopAll, IsConnected is false → next EnsureControlTunnel calls ConnectAsync again.
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.IsConnected.Returns(false); // after disconnect, still false
        tunnel.ConnectAsync(Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));
        tunnel.DisconnectAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);

        using var mgr = Make(tunnel);
        await mgr.StopAllAsync();
        await mgr.EnsureControlTunnelAsync("user@host", 18789, CancellationToken.None);

        await tunnel.Received(1).ConnectAsync(
            Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>());
    }

    // ── RestartBackoffSeconds constant ────────────────────────────────────────

    [Fact]
    public async Task EnsureControlTunnel_NoBackoffOnFirstCall_CompletesQuickly()
    {
        // Swift: private let restartBackoffSeconds: TimeInterval = 2.0
        // No lastRestartAt on a fresh manager → WaitForRestartBackoffIfNeeded returns immediately.
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.IsConnected.Returns(false);
        tunnel.ConnectAsync(Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));

        using var mgr = Make(tunnel);
        var sw = global::System.Diagnostics.Stopwatch.StartNew();
        await mgr.EnsureControlTunnelAsync("user@host", 18789, CancellationToken.None);
        sw.Stop();

        // No lastRestartAt → no backoff → should complete well under 1 s
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(1));
    }
}
