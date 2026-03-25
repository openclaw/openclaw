namespace OpenClawWindows.Domain.WorkActivity;

internal sealed record WorkActivity(
    string SessionKey,
    SessionRole Role,
    ActivityKind Kind,
    string Label,
    DateTimeOffset StartedAt,
    DateTimeOffset LastUpdate);
