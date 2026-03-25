using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Gateway;

// No macOS equivalent test — Windows-only tests based on GatewayConnectivityCoordinator.swift behavior.
public sealed class GatewayConnectivityCoordinatorTests
{
    private static readonly Uri DefaultUrl   = new("ws://127.0.0.1:18789");
    private static readonly Uri AlternateUrl = new("ws://192.168.1.2:18789");

    private static GatewayConnectivityCoordinator Make(
        IGatewayEndpointStore? eps = null,
        IMediator?             med = null,
        IPortGuardian?         pg  = null)
        => new(
            eps ?? StubStore(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "none")),
            med ?? Substitute.For<IMediator>(),
            pg  ?? Substitute.For<IPortGuardian>(),
            NullLogger<GatewayConnectivityCoordinator>.Instance);

    private static IGatewayEndpointStore StubStore(GatewayEndpointState initial)
    {
        var store = Substitute.For<IGatewayEndpointStore>();
        store.CurrentState.Returns(initial);
        return store;
    }

    private static void RaiseStateChanged(IGatewayEndpointStore store, GatewayEndpointState state)
        // Raise.Event<TDelegate> works for any delegate type including EventHandler<T> where T : non-EventArgs
        => store.StateChanged +=
            Raise.Event<EventHandler<GatewayEndpointState>>(store, state);

    // ── StartAsync ────────────────────────────────────────────────────────────

    [Fact]
    public async Task StartAsync_ProcessesInitialReadyState()
    {
        var store = StubStore(new GatewayEndpointState.Ready(ConnectionMode.Local, DefaultUrl, null, null));
        var coord = Make(eps: store);

        await coord.StartAsync(CancellationToken.None);

        Assert.Equal(ConnectionMode.Local, coord.ResolvedMode);
        Assert.Equal("127.0.0.1:18789", coord.ResolvedHostLabel);
    }

    [Fact]
    public async Task StartAsync_ProcessesInitialConnectingState()
    {
        var store = StubStore(new GatewayEndpointState.Connecting(ConnectionMode.Remote, "Connecting…"));
        var coord = Make(eps: store);

        await coord.StartAsync(CancellationToken.None);

        Assert.Equal(ConnectionMode.Remote, coord.ResolvedMode);
    }

    [Fact]
    public async Task StartAsync_ProcessesInitialUnavailableState()
    {
        var store = StubStore(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "not set"));
        var coord = Make(eps: store);

        await coord.StartAsync(CancellationToken.None);

        Assert.Equal(ConnectionMode.Unconfigured, coord.ResolvedMode);
    }

    [Fact]
    public async Task StartAsync_KicksPortSweepWithInitialMode()
    {
        var store = StubStore(new GatewayEndpointState.Ready(ConnectionMode.Local, DefaultUrl, null, null));
        var pg    = Substitute.For<IPortGuardian>();
        var coord = Make(eps: store, pg: pg);

        await coord.StartAsync(CancellationToken.None);
        await Task.Yield();

        _ = pg.Received(1).SweepAsync(ConnectionMode.Local);
    }

    [Fact]
    public async Task StartAsync_SubscribesToStateChanged()
    {
        var store = Substitute.For<IGatewayEndpointStore>();
        store.CurrentState.Returns(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "none"));
        var coord = Make(eps: store);

        await coord.StartAsync(CancellationToken.None);

        store.ReceivedWithAnyArgs().StateChanged += null;
    }

    // ── StopAsync ────────────────────────────────────────────────────────────

    [Fact]
    public async Task StopAsync_UnsubscribesFromStateChanged()
    {
        var store = Substitute.For<IGatewayEndpointStore>();
        store.CurrentState.Returns(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "none"));
        var coord = Make(eps: store);

        await coord.StartAsync(CancellationToken.None);
        await coord.StopAsync(CancellationToken.None);

        store.ReceivedWithAnyArgs().StateChanged -= null;
    }

    // ── State change handling ────────────────────────────────────────────────

    [Fact]
    public async Task StateChanged_Ready_UpdatesResolvedProperties()
    {
        var store = Substitute.For<IGatewayEndpointStore>();
        store.CurrentState.Returns(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "none"));
        var coord = Make(eps: store);
        await coord.StartAsync(CancellationToken.None);

        RaiseStateChanged(store, new GatewayEndpointState.Ready(ConnectionMode.Local, DefaultUrl, null, null));

        Assert.Equal(ConnectionMode.Local, coord.ResolvedMode);
        Assert.Equal("127.0.0.1:18789", coord.ResolvedHostLabel);
    }

    [Fact]
    public async Task StateChanged_Ready_SameUrl_DoesNotDisconnect()
    {
        var initialReady = new GatewayEndpointState.Ready(ConnectionMode.Local, DefaultUrl, null, null);
        var store = StubStore(initialReady);
        var med   = Substitute.For<IMediator>();
        var coord = Make(eps: store, med: med);
        await coord.StartAsync(CancellationToken.None);

        // Same URL again — no disconnect
        RaiseStateChanged(store, initialReady);

        await med.DidNotReceive().Send(
            Arg.Is<DisconnectFromGatewayCommand>(c => c.Reason == "endpoint_changed"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task StateChanged_Ready_DifferentUrl_SendsDisconnect()
    {
        var initialReady = new GatewayEndpointState.Ready(ConnectionMode.Local, DefaultUrl, null, null);
        var store = StubStore(initialReady);
        var med   = Substitute.For<IMediator>();
        var coord = Make(eps: store, med: med);
        await coord.StartAsync(CancellationToken.None);

        // URL changes → mirrors ControlChannel.shared.refreshEndpoint(reason: "endpoint changed")
        RaiseStateChanged(store, new GatewayEndpointState.Ready(ConnectionMode.Local, AlternateUrl, null, null));

        await med.Received(1).Send(
            Arg.Is<DisconnectFromGatewayCommand>(c => c.Reason == "endpoint_changed"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task StateChanged_Ready_FirstTime_DoesNotDisconnect()
    {
        // _lastResolvedUri is null on first Ready — no disconnect (nothing connected yet)
        var store = Substitute.For<IGatewayEndpointStore>();
        store.CurrentState.Returns(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "none"));
        var med   = Substitute.For<IMediator>();
        var coord = Make(eps: store, med: med);
        await coord.StartAsync(CancellationToken.None);

        RaiseStateChanged(store, new GatewayEndpointState.Ready(ConnectionMode.Local, DefaultUrl, null, null));

        await med.DidNotReceive().Send(
            Arg.Is<DisconnectFromGatewayCommand>(c => c.Reason == "endpoint_changed"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task StateChanged_Connecting_UpdatesMode_NoDisconnect()
    {
        var store = Substitute.For<IGatewayEndpointStore>();
        store.CurrentState.Returns(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "none"));
        var med   = Substitute.For<IMediator>();
        var coord = Make(eps: store, med: med);
        await coord.StartAsync(CancellationToken.None);

        RaiseStateChanged(store, new GatewayEndpointState.Connecting(ConnectionMode.Remote, "Connecting…"));

        Assert.Equal(ConnectionMode.Remote, coord.ResolvedMode);
        await med.DidNotReceiveWithAnyArgs().Send(default!, default);
    }

    [Fact]
    public async Task StateChanged_Unavailable_UpdatesMode_NoDisconnect()
    {
        var store = Substitute.For<IGatewayEndpointStore>();
        store.CurrentState.Returns(new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "none"));
        var med   = Substitute.For<IMediator>();
        var coord = Make(eps: store, med: med);
        await coord.StartAsync(CancellationToken.None);

        RaiseStateChanged(store, new GatewayEndpointState.Unavailable(ConnectionMode.Unconfigured, "no config"));

        Assert.Equal(ConnectionMode.Unconfigured, coord.ResolvedMode);
        await med.DidNotReceiveWithAnyArgs().Send(default!, default);
    }

    // ── HostLabel ────────────────────────────────────────────────────────────

    [Fact]
    public async Task HostLabel_NonDefaultPort_IncludesPort()
    {
        // ws:// default port is 80; 18789 is non-default → label includes port
        var url   = new Uri("ws://127.0.0.1:18789");
        var store = StubStore(new GatewayEndpointState.Ready(ConnectionMode.Local, url, null, null));
        var coord = Make(eps: store);

        await coord.StartAsync(CancellationToken.None);

        Assert.Equal("127.0.0.1:18789", coord.ResolvedHostLabel);
    }
}
