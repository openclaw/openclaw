using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Notifications;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Events;
using OpenClawWindows.Domain.Notifications;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

// ── SystemNotifyHandler ───────────────────────────────────────────────────────

public sealed class SystemNotifyHandlerTests
{
    private readonly INotificationProvider _notifier = Substitute.For<INotificationProvider>();
    private readonly SystemNotifyHandler _handler;

    public SystemNotifyHandlerTests()
    {
        _handler = new SystemNotifyHandler(_notifier, NullLogger<SystemNotifyHandler>.Instance);
        _notifier.ShowAsync(Arg.Any<ToastNotificationRequest>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));
    }

    [Fact]
    public async Task Handle_ValidJson_CallsNotifier()
    {
        var result = await _handler.Handle(
            new SystemNotifyCommand("""{"title":"Alert","body":"Something happened"}"""),
            default);

        result.IsError.Should().BeFalse();
        await _notifier.Received(1).ShowAsync(
            Arg.Is<ToastNotificationRequest>(r =>
                r.Title == "Alert" && r.Body == "Something happened"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_MissingTitle_ReturnsError()
    {
        var result = await _handler.Handle(
            new SystemNotifyCommand("""{"body":"No title here"}"""),
            default);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("NOTIFY-PARSE");
        await _notifier.DidNotReceive().ShowAsync(Arg.Any<ToastNotificationRequest>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_MissingBody_ReturnsError()
    {
        var result = await _handler.Handle(
            new SystemNotifyCommand("""{"title":"Alert"}"""),
            default);

        result.IsError.Should().BeTrue();
        await _notifier.DidNotReceive().ShowAsync(Arg.Any<ToastNotificationRequest>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_InvalidJson_ReturnsError()
    {
        var result = await _handler.Handle(
            new SystemNotifyCommand("{broken_json}"),
            default);

        result.IsError.Should().BeTrue();
        await _notifier.DidNotReceive().ShowAsync(Arg.Any<ToastNotificationRequest>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_NotifierFails_ReturnsError()
    {
        _notifier.ShowAsync(Arg.Any<ToastNotificationRequest>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(Error.Failure("NOTIFY-WIN", "toast platform error")));

        var result = await _handler.Handle(
            new SystemNotifyCommand("""{"title":"Alert","body":"Message"}"""),
            default);

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public async Task Handle_WithActionLabel_PassesThrough()
    {
        await _handler.Handle(
            new SystemNotifyCommand("""{"title":"T","body":"B","actionLabel":"Open","actionUrl":"openclaw://open"}"""),
            default);

        await _notifier.Received(1).ShowAsync(
            Arg.Is<ToastNotificationRequest>(r =>
                r.ActionLabel == "Open" && r.ActionUrl == "openclaw://open"),
            Arg.Any<CancellationToken>());
    }
}

// ── UpdateTrayMenuStateHandler ────────────────────────────────────────────────

public sealed class UpdateTrayMenuStateHandlerTests
{
    private readonly IPublisher _publisher = Substitute.For<IPublisher>();
    private readonly InMemoryTrayMenuStateStore _store = new();
    private readonly UpdateTrayMenuStateHandler _handler;

    public UpdateTrayMenuStateHandlerTests()
    {
        _handler = new UpdateTrayMenuStateHandler(
            _store, _publisher,
            NullLogger<UpdateTrayMenuStateHandler>.Instance);

        _publisher.Publish(Arg.Any<INotification>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
    }

    [Fact]
    public async Task Handle_UpdatesStateStore()
    {
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Connected", "1 session(s)", null, 1, "localhost", false),
            default);

        _store.Current.Should().NotBeNull();
        _store.Current!.ConnectionState.Should().Be("Connected");
    }

    [Fact]
    public async Task Handle_PublishesTrayMenuStateChangedEvent()
    {
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Connected", null, null, 0, null, false),
            default);

        await _publisher.Received(1).Publish(
            Arg.Is<TrayMenuStateChangedEvent>(e => e.State == GatewayState.Connected),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_IsPaused_PublishesPausedState()
    {
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Connected", null, null, 0, null, IsPaused: true),
            default);

        await _publisher.Received(1).Publish(
            Arg.Is<TrayMenuStateChangedEvent>(e => e.State == GatewayState.Paused),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_Disconnected_PublishesDisconnectedState()
    {
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("Disconnected", null, null, 0, null, false),
            default);

        await _publisher.Received(1).Publish(
            Arg.Is<TrayMenuStateChangedEvent>(e => e.State == GatewayState.Disconnected),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_VoiceWakeActive_PublishesVoiceWakeActiveState()
    {
        await _handler.Handle(
            new UpdateTrayMenuStateCommand("VoiceWakeActive", null, null, 0, null, false),
            default);

        await _publisher.Received(1).Publish(
            Arg.Is<TrayMenuStateChangedEvent>(e => e.State == GatewayState.VoiceWakeActive),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_ReturnsSuccess()
    {
        var result = await _handler.Handle(
            new UpdateTrayMenuStateCommand("Disconnected", null, null, 0, null, false),
            default);

        result.IsError.Should().BeFalse();
    }
}
