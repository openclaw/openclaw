namespace OpenClawWindows.Domain.Health;

// Discriminated union: pattern-match with is/switch expressions.
public abstract record HealthState
{
    public sealed record Unknown : HealthState;
    public sealed record Ok : HealthState;
    public sealed record LinkingNeeded : HealthState;
    public sealed record Degraded(string Reason) : HealthState;
}
