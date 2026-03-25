namespace OpenClawWindows.Application.Stores;

/// <summary>
/// In-memory registry of gateway sessions.
/// Populated by CreateSessionHandler; read by CloseSessionHandler.
/// </summary>
public interface ISessionStore
{
    int ActiveCount { get; }

    void Add(string sessionKey, DateTimeOffset startedAt);
    void CloseActive(DateTimeOffset endedAt);
}
