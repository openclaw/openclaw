namespace OpenClawWindows.Domain.Sessions;

public enum SessionKind
{
    Direct,
    Group,
    Global,
    Unknown,
}

public static class SessionKindHelper
{
    public static SessionKind From(string key)
    {
        if (key == "global") return SessionKind.Global;
        if (key.StartsWith("group:", StringComparison.Ordinal)) return SessionKind.Group;
        if (key.Contains(":group:", StringComparison.Ordinal)) return SessionKind.Group;
        if (key.Contains(":channel:", StringComparison.Ordinal)) return SessionKind.Group;
        if (key == "unknown") return SessionKind.Unknown;
        return SessionKind.Direct;
    }

    public static string ToLabel(this SessionKind kind) => kind switch
    {
        SessionKind.Direct  => "Direct",
        SessionKind.Group   => "Group",
        SessionKind.Global  => "Global",
        SessionKind.Unknown => "Unknown",
        _                   => "Unknown",
    };
}
