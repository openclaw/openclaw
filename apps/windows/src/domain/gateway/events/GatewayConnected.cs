using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Gateway.Events;

public sealed record GatewayConnected : DomainEvent
{
    public required string SessionKey { get; init; }
}
