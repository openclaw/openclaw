using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Tests.Unit.Application.Gateway;

public sealed class ConnectionModeCoordinatorTests
{
    private static ConnectionModeCoordinator Make(
        IGatewayProcessManager? pm   = null,
        IRemoteTunnelService?   rts  = null,
        INodesStore?            ns   = null,
        IGatewayEndpointStore?  eps  = null,
        IPortGuardian?          pg   = null,
        IMediator?              med  = null)
        => new(
            pm  ?? Substitute.For<IGatewayProcessManager>(),
            rts ?? Substitute.For<IRemoteTunnelService>(),
            ns  ?? Substitute.For<INodesStore>(),
            eps ?? Substitute.For<IGatewayEndpointStore>(),
            pg  ?? Substitute.For<IPortGuardian>(),
            med ?? Substitute.For<IMediator>(),
            NullLogger<ConnectionModeCoordinator>.Instance);

    // ── Unconfigured ─────────────────────────────────────────────────────────

    [Fact]
    public async Task Unconfigured_StopsProcess_DisconnectsTunnel_SendsDisconnectCommand()
    {
        var pm  = Substitute.For<IGatewayProcessManager>();
        var rts = Substitute.For<IRemoteTunnelService>();
        var med = Substitute.For<IMediator>();
        var coord = Make(pm: pm, rts: rts, med: med);

        await coord.ApplyAsync(ConnectionMode.Unconfigured, paused: false);

        pm.Received().SetActive(false);
        await rts.Received().DisconnectAsync(Arg.Any<CancellationToken>());
        await med.Received().Send(
            Arg.Is<DisconnectFromGatewayCommand>(c => c.Reason == "mode_unconfigured"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Unconfigured_ClearsNodeError()
    {
        var ns    = Substitute.For<INodesStore>();
        var coord = Make(ns: ns);

        await coord.ApplyAsync(ConnectionMode.Unconfigured, paused: false);

        ns.Received().SetCancelled(null);
    }

    [Fact]
    public async Task Unconfigured_KicksPortSweep()
    {
        var pg    = Substitute.For<IPortGuardian>();
        var coord = Make(pg: pg);

        await coord.ApplyAsync(ConnectionMode.Unconfigured, paused: false);

        // Fire-and-forget sweep — mirrors Swift Task.detached { PortGuardian.shared.sweep(mode: .unconfigured) }
        _ = pg.Received(1).SweepAsync(ConnectionMode.Unconfigured);
    }

    // ── Local — should start ─────────────────────────────────────────────────

    [Fact]
    public async Task Local_NotPaused_SetsActiveTrue_WaitsForReady()
    {
        var pm    = Substitute.For<IGatewayProcessManager>();
        var coord = Make(pm: pm);

        await coord.ApplyAsync(ConnectionMode.Local, paused: false);

        pm.Received().SetActive(true);
        await pm.Received().WaitForGatewayReadyAsync(
            Arg.Any<TimeSpan>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Local_NotPaused_StopsRemoteTunnel()
    {
        var rts   = Substitute.For<IRemoteTunnelService>();
        var coord = Make(rts: rts);

        await coord.ApplyAsync(ConnectionMode.Local, paused: false);

        await rts.Received().DisconnectAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Local_KicksPortSweep()
    {
        var pg    = Substitute.For<IPortGuardian>();
        var coord = Make(pg: pg);

        await coord.ApplyAsync(ConnectionMode.Local, paused: false);

        _ = pg.Received(1).SweepAsync(ConnectionMode.Local);
    }

    // ── Local — paused (should NOT start) ────────────────────────────────────

    [Fact]
    public async Task Local_Paused_SetsActiveFalse_DoesNotWaitForReady()
    {
        var pm    = Substitute.For<IGatewayProcessManager>();
        var coord = Make(pm: pm);

        await coord.ApplyAsync(ConnectionMode.Local, paused: true);

        pm.Received().SetActive(false);
        await pm.DidNotReceive().WaitForGatewayReadyAsync(
            Arg.Any<TimeSpan>(), Arg.Any<CancellationToken>());
    }

    // ── Remote ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task Remote_StopsProcess_EnsuresRemoteTunnel()
    {
        var pm  = Substitute.For<IGatewayProcessManager>();
        var eps = Substitute.For<IGatewayEndpointStore>();
        var coord = Make(pm: pm, eps: eps);

        await coord.ApplyAsync(ConnectionMode.Remote, paused: false);

        pm.Received().SetActive(false);
        await eps.Received().EnsureRemoteControlTunnelAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Remote_TunnelThrows_DoesNotPropagate()
    {
        var eps = Substitute.For<IGatewayEndpointStore>();
        eps.EnsureRemoteControlTunnelAsync(Arg.Any<CancellationToken>())
           .ThrowsAsync(new InvalidOperationException("tunnel failed"));

        var coord = Make(eps: eps);

        // Must not throw
        await coord.ApplyAsync(ConnectionMode.Remote, paused: false);
    }

    [Fact]
    public async Task Remote_KicksPortSweep()
    {
        var pg    = Substitute.For<IPortGuardian>();
        var coord = Make(pg: pg);

        await coord.ApplyAsync(ConnectionMode.Remote, paused: false);

        _ = pg.Received(1).SweepAsync(ConnectionMode.Remote);
    }

    // ── Mode-change clears node error ────────────────────────────────────────

    [Fact]
    public async Task ModeChange_ClearsNodeError_OnTransition()
    {
        var ns    = Substitute.For<INodesStore>();
        var coord = Make(ns: ns);

        // First call sets _lastMode = Local
        await coord.ApplyAsync(ConnectionMode.Local, paused: false);
        ns.ClearReceivedCalls();

        // Second call with different mode triggers modeChanged path
        await coord.ApplyAsync(ConnectionMode.Remote, paused: false);

        // Remote case also calls SetCancelled, and modeChanged path calls it too
        ns.Received().SetCancelled(null);
    }
}
