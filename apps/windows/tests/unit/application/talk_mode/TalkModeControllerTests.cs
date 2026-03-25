using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.TalkMode;

namespace OpenClawWindows.Tests.Unit.Application.TalkMode;

public sealed class TalkModeControllerTests
{
    private readonly ITalkModeRuntime    _runtime    = Substitute.For<ITalkModeRuntime>();
    private readonly ITalkOverlayBridge  _overlay    = Substitute.For<ITalkOverlayBridge>();
    private readonly IGatewayRpcChannel  _rpc        = Substitute.For<IGatewayRpcChannel>();
    private readonly ISender             _sender     = Substitute.For<ISender>();
    private readonly TalkModeController  _controller;

    public TalkModeControllerTests()
    {
        _runtime.SetEnabledAsync(Arg.Any<bool>()).Returns(Task.CompletedTask);
        _runtime.SetPausedAsync(Arg.Any<bool>()).Returns(Task.CompletedTask);
        _runtime.StopSpeakingAsync(Arg.Any<TalkStopReason>()).Returns(Task.CompletedTask);
        _rpc.TalkModeAsync(Arg.Any<bool>(), Arg.Any<string?>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        _sender.Send(Arg.Any<StopTalkModeCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));

        _controller = new TalkModeController(
            _runtime, _overlay, _rpc, _sender,
            NullLogger<TalkModeController>.Instance);
    }

    // ── SetEnabledAsync ────────────────────────────────────────────────────────

    [Fact]
    public async Task SetEnabledAsync_True_CallsOverlayPresent()
    {
        await _controller.SetEnabledAsync(true);

        _overlay.Received(1).Present();
        _overlay.DidNotReceive().Dismiss();
    }

    [Fact]
    public async Task SetEnabledAsync_True_CallsRuntimeSetEnabled()
    {
        await _controller.SetEnabledAsync(true);

        await _runtime.Received(1).SetEnabledAsync(true);
    }

    [Fact]
    public async Task SetEnabledAsync_False_CallsOverlayDismiss()
    {
        await _controller.SetEnabledAsync(false);

        _overlay.Received(1).Dismiss();
        _overlay.DidNotReceive().Present();
    }

    [Fact]
    public async Task SetEnabledAsync_False_CallsRuntimeSetEnabled()
    {
        await _controller.SetEnabledAsync(false);

        await _runtime.Received(1).SetEnabledAsync(false);
    }

    // ── PhaseChanged event ────────────────────────────────────────────────────

    [Fact]
    public async Task PhaseChanged_ForwardsToOverlay()
    {
        await _controller.SetEnabledAsync(true);

        _runtime.PhaseChanged += Raise.Event<EventHandler<TalkModePhase>>(this, TalkModePhase.Listening);

        _overlay.Received(1).UpdatePhase(TalkModePhase.Listening);
    }

    [Fact]
    public async Task PhaseChanged_NotifyGatewayWithCorrectPhaseString()
    {
        await _controller.SetEnabledAsync(true);
        _rpc.ClearReceivedCalls();

        _runtime.PhaseChanged += Raise.Event<EventHandler<TalkModePhase>>(this, TalkModePhase.Processing);
        await Task.Yield(); // let fire-and-forget TalkModeAsync complete

        await _rpc.Received().TalkModeAsync(
            Arg.Any<bool>(),
            Arg.Is<string?>(s => s == "thinking"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PhaseChanged_WhenPaused_GatewaySendsPaused()
    {
        await _controller.SetEnabledAsync(true);
        await _controller.SetPausedAsync(true);
        _rpc.ClearReceivedCalls();

        _runtime.PhaseChanged += Raise.Event<EventHandler<TalkModePhase>>(this, TalkModePhase.Listening);
        await Task.Yield();

        await _rpc.Received().TalkModeAsync(
            Arg.Any<bool>(),
            Arg.Is<string?>(s => s == "paused"),
            Arg.Any<CancellationToken>());
    }

    // ── LevelChanged event ────────────────────────────────────────────────────

    [Fact]
    public void LevelChanged_ForwardsToOverlay()
    {
        _runtime.LevelChanged += Raise.Event<EventHandler<double>>(this, 0.75);

        _overlay.Received(1).UpdateLevel(0.75);
    }

    // ── SetPausedAsync ────────────────────────────────────────────────────────

    [Fact]
    public async Task SetPausedAsync_True_CallsOverlayUpdatePaused()
    {
        await _controller.SetPausedAsync(true);

        _overlay.Received(1).UpdatePaused(true);
    }

    [Fact]
    public async Task SetPausedAsync_True_CallsRuntimeSetPaused()
    {
        await _controller.SetPausedAsync(true);

        await _runtime.Received(1).SetPausedAsync(true);
    }

    [Fact]
    public async Task SetPausedAsync_True_GatewaySendsPaused()
    {
        await _controller.SetPausedAsync(true);
        await Task.Yield();

        await _rpc.Received().TalkModeAsync(
            Arg.Any<bool>(),
            Arg.Is<string?>(s => s == "paused"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetPausedAsync_SameValue_IsNoop()
    {
        // Default is not-paused. Calling SetPausedAsync(false) again is a no-op.
        await _controller.SetPausedAsync(false);

        _overlay.DidNotReceive().UpdatePaused(Arg.Any<bool>());
        await _runtime.DidNotReceive().SetPausedAsync(Arg.Any<bool>());
    }

    [Fact]
    public async Task SetPausedAsync_Unpause_GatewaySendsActualPhase()
    {
        await _controller.SetPausedAsync(true);
        _rpc.ClearReceivedCalls();

        await _controller.SetPausedAsync(false);
        await Task.Yield();

        // Effective phase is the runtime phase, which is Idle (no phase event fired) → "idle".
        await _rpc.Received().TalkModeAsync(
            Arg.Any<bool>(),
            Arg.Is<string?>(s => s == "idle"),
            Arg.Any<CancellationToken>());
    }

    // ── TogglePausedAsync ────────────────────────────────────────────────────

    [Fact]
    public async Task TogglePausedAsync_FlipsFalseToTrue()
    {
        await _controller.TogglePausedAsync();

        _overlay.Received(1).UpdatePaused(true);
    }

    [Fact]
    public async Task TogglePausedAsync_FlipsTrueToFalse()
    {
        await _controller.SetPausedAsync(true);
        _overlay.ClearReceivedCalls();

        await _controller.TogglePausedAsync();

        _overlay.Received(1).UpdatePaused(false);
    }

    // ── StopSpeakingAsync ─────────────────────────────────────────────────────

    [Fact]
    public async Task StopSpeakingAsync_ForwardsToRuntime()
    {
        await _controller.StopSpeakingAsync(TalkStopReason.UserTap);

        await _runtime.Received(1).StopSpeakingAsync(TalkStopReason.UserTap);
    }

    [Fact]
    public async Task StopSpeakingAsync_DefaultReason_IsUserTap()
    {
        await _controller.StopSpeakingAsync();

        await _runtime.Received(1).StopSpeakingAsync(TalkStopReason.UserTap);
    }

    // ── ExitTalkModeAsync ─────────────────────────────────────────────────────

    [Fact]
    public async Task ExitTalkModeAsync_SendsStopTalkModeCommand()
    {
        await _controller.ExitTalkModeAsync();

        await _sender.Received(1).Send(
            Arg.Is<StopTalkModeCommand>(cmd => cmd.Reason == "user_exit"),
            Arg.Any<CancellationToken>());
    }

    // ── Phase string mapping ──────────────────────────────────────────────────

    [Theory]
    [InlineData(TalkModePhase.Idle,       "idle")]
    [InlineData(TalkModePhase.Listening,  "listening")]
    [InlineData(TalkModePhase.Processing, "thinking")]
    [InlineData(TalkModePhase.Speaking,   "speaking")]
    public async Task PhaseChanged_MapsPhaseToCorrectGatewayString(TalkModePhase phase, string expected)
    {
        await _controller.SetEnabledAsync(true);
        _rpc.ClearReceivedCalls();

        _runtime.PhaseChanged += Raise.Event<EventHandler<TalkModePhase>>(this, phase);
        // Task.Yield() is insufficient for Task.Run fire-and-forget on some scheduler orderings.
        await Task.Delay(50);

        await _rpc.Received().TalkModeAsync(
            Arg.Any<bool>(),
            Arg.Is<string?>(s => s == expected),
            Arg.Any<CancellationToken>());
    }
}
