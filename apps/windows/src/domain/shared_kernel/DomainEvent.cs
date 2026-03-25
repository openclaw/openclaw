using MediatR;

namespace OpenClawWindows.Domain.SharedKernel;

// ENTERPRISE C# (MH-006): base record — INotification makes all events MediatR-dispatchable.
// ENTERPRISE C# (MH-004): OccurredAt populated by dispatcher via TimeProvider, not DateTime.UtcNow.
public abstract record DomainEvent : IDomainEvent
{
    public DateTimeOffset OccurredAt { get; init; }  // Set by dispatcher via TimeProvider (MH-004)
    public Guid EventId { get; init; } = Guid.NewGuid();
    public string CorrelationId { get; init; } = string.Empty;
    public string EventType => GetType().Name;
}
