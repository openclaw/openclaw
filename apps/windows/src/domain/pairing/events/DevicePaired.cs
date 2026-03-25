using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Pairing.Events;

public sealed record DevicePaired : DomainEvent
{
    public required string PublicKeyBase64 { get; init; }
}
