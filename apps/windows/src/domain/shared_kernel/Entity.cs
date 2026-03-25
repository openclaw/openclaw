namespace OpenClawWindows.Domain.SharedKernel;

/// <summary>
/// Base for domain entities with identity and domain event tracking.
/// Traceability: BC-024 SharedKernel
/// </summary>
public abstract class Entity<TId>
    where TId : notnull
{
    private readonly List<IDomainEvent> _domainEvents = [];

    public TId Id { get; protected init; } = default!;

    public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();

    protected void RaiseDomainEvent(IDomainEvent domainEvent) =>
        _domainEvents.Add(domainEvent);

    public void ClearDomainEvents() => _domainEvents.Clear();
}
