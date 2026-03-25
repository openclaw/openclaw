using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Events;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.SystemTray;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Integration.Tray;

// Integration: UpdateTrayMenuStateHandler wires InMemoryTrayMenuStateStore + IPublisher.
// Verifies the full path: handler → store update → event publish with correct GatewayState.
public sealed class TrayLifecycleTests
{
    private readonly InMemoryTrayMenuStateStore _store = new();
    private readonly IPublisher _publisher = Substitute.For<IPublisher>();
    private readonly UpdateTrayMenuStateHandler _handler;

    public TrayLifecycleTests()
    {
        _publisher.Publish(Arg.Any<INotification>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        _handler = new UpdateTrayMenuStateHandler(
            _store, _publisher,
            NullLogger<UpdateTrayMenuStateHandler>.Instance);
    }

    [Fact]
    public async Task Handle_Connected_StoresStateAndPublishesConnectedEvent()
    {
        TrayMenuStateChangedEvent? captured = null;
        _publisher.Publish(Arg.Do<TrayMenuStateChangedEvent>(e => captured = e), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var result = await _handler.Handle(
            new UpdateTrayMenuStateCommand("Connected", "global", "50k", 2, "dev", false), default);

        result.IsError.Should().BeFalse();
        _store.Current.Should().NotBeNull();
        _store.Current!.ConnectionState.Should().Be("Connected");
        _store.Current.ActiveSessionLabel.Should().Be("global");
        _store.Current.ConnectedNodeCount.Should().Be(2);
        captured.Should().NotBeNull();
        captured!.State.Should().Be(GatewayState.Connected);
        captured.ActiveSessionLabel.Should().Be("global");
    }

    [Fact]
    public async Task Handle_Paused_PublishesPausedRegardlessOfConnectionState()
    {
        TrayMenuStateChangedEvent? captured = null;
        _publisher.Publish(Arg.Do<TrayMenuStateChangedEvent>(e => captured = e), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        // Socket says "Connected" but node is paused — Paused takes precedence (mirrors macOS)
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Connected", null, null, 0, null, IsPaused: true), default);

        captured!.State.Should().Be(GatewayState.Paused);
        _store.Current!.IsPaused.Should().BeTrue();
    }

    [Fact]
    public async Task Handle_MultipleUpdates_StoreAlwaysHoldsLatest()
    {
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Connected", "s1", null, 1, "dev", false), default);
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Disconnected", null, null, 0, null, false), default);

        _store.Current!.ConnectionState.Should().Be("Disconnected");
        _store.Current.ConnectedNodeCount.Should().Be(0);
    }

    [Theory]
    [InlineData("connected",       GatewayState.Connected)]
    [InlineData("connecting",      GatewayState.Connecting)]
    [InlineData("reconnecting",    GatewayState.Reconnecting)]
    [InlineData("voicewakeactive", GatewayState.VoiceWakeActive)]
    [InlineData("disconnected",    GatewayState.Disconnected)]
    [InlineData("unknown",         GatewayState.Disconnected)]
    public async Task Handle_ConnectionState_MapsToCorrectGatewayState(
        string connectionState, GatewayState expected)
    {
        TrayMenuStateChangedEvent? captured = null;
        _publisher.Publish(Arg.Do<TrayMenuStateChangedEvent>(e => captured = e), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        await _handler.Handle(
            new UpdateTrayMenuStateCommand(connectionState, null, null, 0, null, false), default);

        captured!.State.Should().Be(expected);
    }

    [Fact]
    public async Task Handle_StoreInitiallyNull_AfterFirstHandle_HasState()
    {
        _store.Current.Should().BeNull();

        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Disconnected", null, null, 0, null, false), default);

        _store.Current.Should().NotBeNull();
    }

    [Fact]
    public async Task Handle_WithGatewayDisplayName_StoredInState()
    {
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Connected", null, null, 0, "my-gateway", false), default);

        _store.Current!.GatewayDisplayName.Should().Be("my-gateway");
    }
}
