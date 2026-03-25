using OpenClawWindows.Domain.Health;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// In-memory cache of gateway health data polled every 60 s.
/// </summary>
public interface IHealthStore
{
    HealthSnapshot? Snapshot { get; }
    DateTimeOffset? LastSuccess { get; }
    string? LastError { get; }
    bool IsRefreshing { get; }

    // Derived from Snapshot + LastError — pure state machine.
    HealthState State { get; }
    string SummaryLine { get; }
    string? DegradedSummary { get; }

    // Raised on the calling thread when any property changes.
    event EventHandler? HealthChanged;

    void Apply(HealthSnapshot snapshot);
    void SetError(string error);
    void SetRefreshing(bool refreshing);
}
