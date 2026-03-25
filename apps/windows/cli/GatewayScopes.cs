// Mirrors GatewayScopes.swift: default operator scopes sent on connect.
namespace OpenClawWindows.CLI;

internal static class GatewayScopes
{
    internal static readonly string[] DefaultOperatorConnectScopes =
    [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
    ];
}
