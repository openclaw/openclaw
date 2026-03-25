using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Gateway.Events;

public sealed record GatewayDisconnected : DomainEvent
{
    public required string Reason { get; init; }
}
