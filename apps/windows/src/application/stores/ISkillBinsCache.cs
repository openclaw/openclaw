namespace OpenClawWindows.Application.Stores;

/// <summary>
/// Cache of executable names declared as requirements by installed skills.
/// Used by the exec-approval evaluator to auto-allow skill-owned binaries.
/// </summary>
public interface ISkillBinsCache
{
    // Returns the current set of skill-declared binary names.
    // Refreshes from the gateway when the 90 s TTL has elapsed.
    Task<IReadOnlySet<string>> CurrentBinsAsync(CancellationToken ct = default);
}
