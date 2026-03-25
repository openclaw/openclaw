using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.TalkMode;

namespace OpenClawWindows.Tests.Unit.Infrastructure.TalkMode;

public sealed class TalkModeRuntimeTests
{
    private readonly ISpeechRecognizer _recognizer = Substitute.For<ISpeechRecognizer>();
    private readonly ISpeechSynthesizer _systemVoice = Substitute.For<ISpeechSynthesizer>();
    private readonly IGatewayRpcChannel _rpc = Substitute.For<IGatewayRpcChannel>();
    private readonly IHttpClientFactory _httpFactory = Substitute.For<IHttpClientFactory>();
    private readonly WindowsTalkModeRuntime _runtime;

    public TalkModeRuntimeTests()
    {
        _runtime = new WindowsTalkModeRuntime(
            _recognizer, _systemVoice, _rpc, _httpFactory,
            NullLogger<WindowsTalkModeRuntime>.Instance);

        // talk.config: return an empty-config payload so ReloadConfigAsync exits cleanly.
        _rpc.RequestRawAsync(
                Arg.Any<string>(),
                Arg.Any<Dictionary<string, object?>>(),
                Arg.Any<int?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(Encoding.UTF8.GetBytes("""{"config":{}}""")));

        // TalkModeAsync is fire-and-forget; silence it so it doesn't interfere.
        _rpc.TalkModeAsync(Arg.Any<bool>(), Arg.Any<string?>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        // Recognizer: hold until CT is cancelled (simulates continuous recognition).
        _recognizer.StartContinuousAsync(
                Arg.Any<RecognitionMode>(),
                Arg.Any<Func<string, float, Task>>(),
                Arg.Any<Func<string, float, Task>>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                var ct = call.Arg<CancellationToken>();
                return Task.Delay(Timeout.Infinite, ct).ContinueWith(_ => { });
            });

        _recognizer.StopAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        _systemVoice.StopAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
    }

    // ── Initial state ─────────────────────────────────────────────────────────

    [Fact]
    public void InitialPhase_IsIdle()
    {
        _runtime.Phase.Should().Be(TalkModePhase.Idle);
    }

    // ── SetEnabledAsync idempotency ────────────────────────────────────────────

    [Fact]
    public async Task SetEnabledAsync_FalseWhenAlreadyDisabled_IsNoop()
    {
        // No state should change — SetEnabled(false) when already disabled.
        await _runtime.SetEnabledAsync(false);

        _runtime.Phase.Should().Be(TalkModePhase.Idle);
        // RPC should not have been called.
        await _rpc.DidNotReceive().RequestRawAsync(
            Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(), Arg.Any<int?>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetEnabledAsync_TrueWhenAlreadyEnabled_IsNoop()
    {
        // First enable (with paused so it's quick and deterministic).
        await _runtime.SetPausedAsync(true);
        await _runtime.SetEnabledAsync(true);

        // Second enable: same value, no lifecycle change.
        _rpc.ClearReceivedCalls();
        await _runtime.SetEnabledAsync(true);

        await _rpc.DidNotReceive().RequestRawAsync(
            Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(), Arg.Any<int?>(), Arg.Any<CancellationToken>());
    }

    // ── SetEnabledAsync with paused ───────────────────────────────────────────

    [Fact]
    public async Task SetEnabledAsync_TrueWhenPaused_PhaseRemainsIdle()
    {
        // When paused=true, StartInternalAsync exits immediately before calling RPC.
        await _runtime.SetPausedAsync(true);
        await _runtime.SetEnabledAsync(true);

        _runtime.Phase.Should().Be(TalkModePhase.Idle);
        // RPC must NOT be called when paused.
        await _rpc.DidNotReceive().RequestRawAsync(
            Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(), Arg.Any<int?>(), Arg.Any<CancellationToken>());
    }

    // ── SetEnabledAsync → Listening ───────────────────────────────────────────

    [Fact]
    public async Task SetEnabledAsync_True_PhaseBecomeListening()
    {
        await _runtime.SetEnabledAsync(true);

        _runtime.Phase.Should().Be(TalkModePhase.Listening);
    }

    [Fact]
    public async Task SetEnabledAsync_True_PhaseChangedEventFired()
    {
        var phases = new List<TalkModePhase>();
        _runtime.PhaseChanged += (_, p) => phases.Add(p);

        await _runtime.SetEnabledAsync(true);

        phases.Should().Contain(TalkModePhase.Listening);
    }

    // ── SetEnabledAsync false → Idle ──────────────────────────────────────────

    [Fact]
    public async Task SetEnabledAsync_FalseAfterTrue_PhaseBecomesIdle()
    {
        await _runtime.SetEnabledAsync(true);
        _runtime.Phase.Should().Be(TalkModePhase.Listening);

        await _runtime.SetEnabledAsync(false);

        _runtime.Phase.Should().Be(TalkModePhase.Idle);
    }

    // ── SetPausedAsync ────────────────────────────────────────────────────────

    [Fact]
    public async Task SetPausedAsync_TrueWhenNotEnabled_NoPhaseChange()
    {
        // Pause when not enabled is a no-op (except internal flag).
        await _runtime.SetPausedAsync(true);
        _runtime.Phase.Should().Be(TalkModePhase.Idle);
    }

    [Fact]
    public async Task SetPausedAsync_TrueWhenEnabled_StopsRecognition()
    {
        await _runtime.SetEnabledAsync(true);

        await _runtime.SetPausedAsync(true);

        // StopRecognitionAsync cancels the internal CTS, so StopAsync on recognizer is called.
        await _recognizer.Received().StopAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetPausedAsync_FalseWhenAlreadyNotPaused_IsNoop()
    {
        // Already unpaused, setting to false again should not restart anything.
        _rpc.ClearReceivedCalls();
        await _runtime.SetPausedAsync(false);

        _runtime.Phase.Should().Be(TalkModePhase.Idle);
        await _rpc.DidNotReceive().RequestRawAsync(
            Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(), Arg.Any<int?>(), Arg.Any<CancellationToken>());
    }

    // ── StopSpeakingAsync ─────────────────────────────────────────────────────

    [Fact]
    public async Task StopSpeakingAsync_WhenNotSpeaking_DoesNotChangePhase()
    {
        // Phase is Idle — StopSpeaking should not alter it.
        await _runtime.StopSpeakingAsync(TalkStopReason.Manual);

        _runtime.Phase.Should().Be(TalkModePhase.Idle);
    }

    [Fact]
    public async Task StopSpeakingAsync_CallsSystemVoiceStop()
    {
        await _runtime.StopSpeakingAsync(TalkStopReason.Manual);

        await _systemVoice.Received(1).StopAsync(Arg.Any<CancellationToken>());
    }

    // ── PhaseChanged event ────────────────────────────────────────────────────

    [Fact]
    public async Task PhaseChanged_FiredOnEnable()
    {
        var fired = 0;
        _runtime.PhaseChanged += (_, _) => fired++;

        await _runtime.SetEnabledAsync(true);

        fired.Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task PhaseChanged_FiredOnDisable()
    {
        await _runtime.SetEnabledAsync(true);
        var fired = 0;
        _runtime.PhaseChanged += (_, _) => fired++;

        await _runtime.SetEnabledAsync(false);

        fired.Should().BeGreaterThan(0);
    }

    // ── IHostedService ────────────────────────────────────────────────────────

    [Fact]
    public async Task StartAsync_DoesNotThrow()
    {
        var act = async () => await _runtime.StartAsync(CancellationToken.None);
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task StopAsync_WhenNotEnabled_DoesNotThrow()
    {
        var act = async () => await _runtime.StopAsync(CancellationToken.None);
        await act.Should().NotThrowAsync();
    }
}
