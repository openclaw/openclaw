using OpenClawWindows.Application.Stores;

namespace OpenClawWindows.Infrastructure.Stores;

internal sealed class InMemorySessionStore : ISessionStore
{
    private readonly Dictionary<string, DateTimeOffset> _sessions = new();
    private readonly object _lock = new();

    public int ActiveCount
    {
        get { lock (_lock) return _sessions.Count; }
    }

    public void Add(string sessionKey, DateTimeOffset startedAt)
    {
        lock (_lock)
            _sessions[sessionKey] = startedAt;
    }

    public void CloseActive(DateTimeOffset endedAt)
    {
        lock (_lock)
            _sessions.Clear();
    }
}
