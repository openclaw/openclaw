namespace OpenClawWindows.Domain.Nodes;

public sealed record NodeInfo(
    string NodeId,
    string? DisplayName,
    string? Platform,
    string? Version,
    string? CoreVersion,
    string? UiVersion,
    string? DeviceFamily,
    string? ModelIdentifier,
    string? RemoteIp,
    IReadOnlyList<string>? Caps,
    IReadOnlyList<string>? Commands,
    IReadOnlyDictionary<string, bool>? Permissions,
    bool? Paired,
    bool? Connected)
{
    public bool IsConnected => Connected ?? false;
    public bool IsPaired    => Paired    ?? false;
}
