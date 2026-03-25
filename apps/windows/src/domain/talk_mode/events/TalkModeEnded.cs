using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.TalkMode.Events;

public sealed record TalkModeEnded : DomainEvent
{
    public required string Reason { get; init; }
}
