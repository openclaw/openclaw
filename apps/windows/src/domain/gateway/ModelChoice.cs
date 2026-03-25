namespace OpenClawWindows.Domain.Gateway;

public sealed record ModelChoice(
    string Id,
    string Name,
    string Provider,
    int? ContextWindow,
    bool? Reasoning = null);
