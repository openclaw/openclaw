using MediatR;

namespace OpenClawWindows.Domain.SharedKernel;

// ENTERPRISE C# (MH-006): All domain events implement INotification for MediatR dispatch.
public interface IDomainEvent : INotification
{
    DateTimeOffset OccurredAt { get; }
}
