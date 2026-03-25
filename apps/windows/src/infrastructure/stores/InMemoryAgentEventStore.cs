using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.AgentEvents;

namespace OpenClawWindows.Infrastructure.Stores;

internal sealed class InMemoryAgentEventStore : IAgentEventStore
{
    // Tunables
    private const int MaxEvents = 400;  // matches macOS maxEvents

    private readonly object _lock = new();
    private readonly List<AgentEvent> _events = new(MaxEvents + 1);

    public event EventHandler<AgentEvent>? EventAppended;

    public IReadOnlyList<AgentEvent> Events
    {
        get { lock (_lock) return _events.ToList(); }
    }

    public void Append(AgentEvent evt)
    {
        lock (_lock)
        {
            _events.Add(evt);
            // Trim oldest entries when the ring overflows
            if (_events.Count > MaxEvents)
                _events.RemoveRange(0, _events.Count - MaxEvents);
        }
        // Fire outside the lock — subscribers must not call back into the store.
        EventAppended?.Invoke(this, evt);
    }

    public void Clear()
    {
        lock (_lock)
            _events.Clear();
    }
}
