namespace OpenClawWindows.Domain.Sessions;

public sealed record SessionsSnapshot(
    string StorePath,
    SessionDefaults Defaults,
    IReadOnlyList<SessionRow> Rows);
