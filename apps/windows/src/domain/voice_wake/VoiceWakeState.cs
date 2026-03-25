namespace OpenClawWindows.Domain.VoiceWake;

public enum VoiceWakeState
{
    Idle,
    Listening,
    WakeWordDetected,
    CapturingUtterance,
    Processing,
}
