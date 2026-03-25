namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Structured audit log for agent activity — feeds AgentEventsWindow.
/// </summary>
public interface IAuditLogger
{
    Task LogAsync(string eventType, string commandOrAction, bool succeeded, string? detail, CancellationToken ct);
    Task<IReadOnlyList<AuditEntry>> GetRecentAsync(int count, CancellationToken ct);
}

public sealed record AuditEntry(DateTimeOffset Timestamp, string EventType, string Action, bool Succeeded, string? Detail);
