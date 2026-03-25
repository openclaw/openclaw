using OpenClawWindows.Domain.TalkMode;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Lifecycle manager for talk mode: STT → silence detection → gateway chatSend → TTS playback.
/// </summary>
internal interface ITalkModeRuntime
{
    TalkModePhase Phase { get; }

    Task SetEnabledAsync(bool enabled);
    Task SetPausedAsync(bool paused);
    Task StopSpeakingAsync(TalkStopReason reason);

    event EventHandler<TalkModePhase> PhaseChanged;
    event EventHandler<double> LevelChanged;
}
