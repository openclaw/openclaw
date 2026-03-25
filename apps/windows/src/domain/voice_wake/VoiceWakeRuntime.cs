using OpenClawWindows.Domain.Errors;
using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.VoiceWake;

/// <summary>
/// Voice wake detection state
/// Manages sensitivity, detection state, and transcript accumulation.
/// </summary>
public sealed class VoiceWakeRuntime : Entity<Guid>
{
    public float Sensitivity { get; private set; }
    public VoiceWakeState State { get; private set; }
    public string? CurrentTranscript { get; private set; }

    private VoiceWakeRuntime(float sensitivity)
    {
        Guard.Against.OutOfRange(sensitivity, nameof(sensitivity), 0.0f, 1.0f);
        Id = Guid.NewGuid();
        Sensitivity = sensitivity;
        State = VoiceWakeState.Idle;
    }

    public static ErrorOr<VoiceWakeRuntime> Create(float sensitivity)
    {
        if (sensitivity is < 0.0f or > 1.0f)
            return DomainErrors.VoiceWake.SensitivityOutOfRange(sensitivity);

        return new VoiceWakeRuntime(sensitivity);
    }

    public void StartListening()
    {
        if (State != VoiceWakeState.Idle)
            throw new InvalidOperationException($"Cannot start listening from state {State}");

        State = VoiceWakeState.Listening;
    }

    public void OnWakeWordDetected()
    {
        State = VoiceWakeState.WakeWordDetected;
        CurrentTranscript = null;
        RaiseDomainEvent(new Events.WakeWordDetected { DetectedAt = DateTimeOffset.UtcNow });
    }

    public void AppendTranscript(string chunk)
    {
        Guard.Against.NullOrWhiteSpace(chunk, nameof(chunk));
        State = VoiceWakeState.CapturingUtterance;
        CurrentTranscript = (CurrentTranscript ?? "") + " " + chunk;
    }

    public void Stop()
    {
        State = VoiceWakeState.Idle;
        CurrentTranscript = null;
    }

    public void UpdateSensitivity(float newSensitivity)
    {
        Guard.Against.OutOfRange(newSensitivity, nameof(newSensitivity), 0.0f, 1.0f);
        Sensitivity = newSensitivity;
    }
}
