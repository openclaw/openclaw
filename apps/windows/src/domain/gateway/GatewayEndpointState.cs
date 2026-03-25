using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Domain.Gateway;

// three cases with associated values.
public abstract record GatewayEndpointState
{
    public sealed record Ready(
        ConnectionMode Mode,
        Uri            Url,
        string?        Token,
        string?        Password) : GatewayEndpointState;

    public sealed record Connecting(
        ConnectionMode Mode,
        string         Detail) : GatewayEndpointState;

    public sealed record Unavailable(
        ConnectionMode Mode,
        string         Reason) : GatewayEndpointState;
}
