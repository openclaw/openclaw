namespace OpenClawWindows.Domain.WorkActivity;

internal enum ToolKind { Bash, Read, Write, Edit, Attach, Other }

internal static class ToolKindHelper
{
    internal static ToolKind From(string? name) => name?.ToLowerInvariant() switch
    {
        "bash" or "shell" => ToolKind.Bash,
        "read"            => ToolKind.Read,
        "write"           => ToolKind.Write,
        "edit"            => ToolKind.Edit,
        "attach"          => ToolKind.Attach,
        _                 => ToolKind.Other,
    };
}
