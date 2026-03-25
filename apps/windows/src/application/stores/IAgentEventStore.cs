using OpenClawWindows.Domain.AgentEvents;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// Ring-buffer store for gateway agent events (job/tool/assistant streams).
/// </summary>
internal interface IAgentEventStore
{
    IReadOnlyList<AgentEvent> Events { get; }

    // Raised after each Append — carries the newly appended event.
    event EventHandler<AgentEvent>? EventAppended;

    void Append(AgentEvent evt);
    void Clear();
}
