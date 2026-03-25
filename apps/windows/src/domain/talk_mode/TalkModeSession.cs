using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.TalkMode;

/// <summary>
/// Single talk mode session — STT input, TTS output, VAD lifecycle.
/// </summary>
public sealed class TalkModeSession : Entity<Guid>
{
    // Tunables
    private const int MaxRecoveryAttempts = 3;  // after 3 STT failures, force to Idle

    public TalkModePhase Phase { get; private set; }
    public int RecoveryAttempts { get; private set; }

    private TalkModeSession()
    {
        Id = Guid.NewGuid();
        Phase = TalkModePhase.Idle;
    }

    public static TalkModeSession Create() => new();

    public void StartListening()
    {
        Phase = TalkModePhase.Listening;
        RecoveryAttempts = 0;
        RaiseDomainEvent(new Events.TalkModeStarted());
    }

    public void TransitionToProcessing() => Phase = TalkModePhase.Processing;

    public void TransitionToSpeaking() => Phase = TalkModePhase.Speaking;

    public void OnError()
    {
        RecoveryAttempts++;

        // after max retries, force back to Idle rather than looping forever
        if (RecoveryAttempts >= MaxRecoveryAttempts)
            Stop();
        else
            Phase = TalkModePhase.Error;
    }

    public void Stop()
    {
        Phase = TalkModePhase.Idle;
        RaiseDomainEvent(new Events.TalkModeEnded { Reason = "stopped" });
    }
}
