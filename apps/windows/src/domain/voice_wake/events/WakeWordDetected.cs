using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.VoiceWake.Events;

public sealed record WakeWordDetected : DomainEvent
{
    public required DateTimeOffset DetectedAt { get; init; }
}
