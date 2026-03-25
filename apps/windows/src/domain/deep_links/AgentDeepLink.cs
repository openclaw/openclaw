namespace OpenClawWindows.Domain.DeepLinks;

public sealed record AgentDeepLink(
    string  Message,
    string? SessionKey,
    string? Thinking,
    bool    Deliver,
    string? To,
    string? Channel,
    int?    TimeoutSeconds,
    string? Key);
