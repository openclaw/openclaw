using MediatR;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.TalkMode;
using OpenClawWindows.Domain.TalkMode;

namespace OpenClawWindows.Application.TalkMode;

/// <summary>
/// Coordinates talk-mode lifecycle: overlay presentation, phase forwarding, paused state, and gateway phase sync.
/// </summary>
internal sealed class TalkModeController
{
    private readonly ITalkModeRuntime _runtime;
    private readonly ITalkOverlayBridge _overlay;
    private readonly IGatewayRpcChannel _rpc;
    private readonly ISender _sender;
    private readonly ILogger<TalkModeController> _logger;

    private readonly object _lock = new();
    private bool _isEnabled;
    private bool _isPaused;
    private TalkModePhase _phase = TalkModePhase.Idle;

    public TalkModeController(
        ITalkModeRuntime runtime,
        ITalkOverlayBridge overlay,
        IGatewayRpcChannel rpc,
        ISender sender,
        ILogger<TalkModeController> logger)
    {
        _runtime = runtime;
        _overlay = overlay;
        _rpc = rpc;
        _sender = sender;
        _logger = logger;

        _runtime.PhaseChanged += OnPhaseChanged;
        _runtime.LevelChanged += OnLevelChanged;
    }

    internal async Task SetEnabledAsync(bool enabled)
    {
        _logger.LogInformation("talk enabled={Enabled}", enabled);

        if (enabled)
            _overlay.Present();
        else
            _overlay.Dismiss();

        await _runtime.SetEnabledAsync(enabled);
        lock (_lock) { _isEnabled = enabled; }
    }

    internal async Task SetPausedAsync(bool paused)
    {
        bool changed;
        lock (_lock) { changed = _isPaused != paused; if (changed) _isPaused = paused; }
        if (!changed) return;

        _logger.LogInformation("talk paused={Paused}", paused);
        _overlay.UpdatePaused(paused);

        TalkModePhase phase;
        bool isEnabled;
        lock (_lock) { phase = _phase; isEnabled = _isEnabled; }

        // "paused" overrides the actual phase for gateway reporting.
        var effectivePhase = paused ? "paused" : PhaseToString(phase);
        _ = Task.Run(async () =>
        {
            try { await _rpc.TalkModeAsync(isEnabled, effectivePhase); }
            catch { }
        });

        await _runtime.SetPausedAsync(paused);
    }

    internal async Task TogglePausedAsync()
    {
        bool current;
        lock (_lock) { current = _isPaused; }
        await SetPausedAsync(!current);
    }

    internal async Task StopSpeakingAsync(TalkStopReason reason = TalkStopReason.UserTap)
    {
        await _runtime.StopSpeakingAsync(reason);
    }

    internal async Task ExitTalkModeAsync()
    {
        await _sender.Send(new StopTalkModeCommand("user_exit"));
    }

    private void OnPhaseChanged(object? sender, TalkModePhase phase)
    {
        lock (_lock) { _phase = phase; }
        _overlay.UpdatePhase(phase);

        bool isPaused, isEnabled;
        lock (_lock) { isPaused = _isPaused; isEnabled = _isEnabled; }

        var effectivePhase = isPaused ? "paused" : PhaseToString(phase);
        _ = Task.Run(async () =>
        {
            try { await _rpc.TalkModeAsync(isEnabled, effectivePhase); }
            catch { }
        });
    }

    private void OnLevelChanged(object? sender, double level)
    {
        _overlay.UpdateLevel(level);
    }

    private static string PhaseToString(TalkModePhase phase) => phase switch
    {
        TalkModePhase.Idle       => "idle",
        TalkModePhase.Listening  => "listening",
        TalkModePhase.Processing => "thinking",
        TalkModePhase.Speaking   => "speaking",
        _                        => "idle",
    };
}
