using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Pairing;

/// <summary>
/// Gateway pairing state — manages the ed25519 keypair lifecycle and pairing handshake.
/// </summary>
public sealed class DevicePairing : Entity<Guid>
{
    public PairingState State { get; private set; }
    public string? PublicKeyBase64 { get; private set; }
    public DateTimeOffset? PairedAt { get; private set; }

    private DevicePairing()
    {
        Id = Guid.NewGuid();
        State = PairingState.Unpaired;
    }

    public static DevicePairing Create() => new();

    public void SetKeypair(Ed25519KeyPair keypair)
    {
        Guard.Against.Null(keypair, nameof(keypair));
        PublicKeyBase64 = keypair.PublicKeyBase64;
    }

    public void RequestPairing()
    {
        if (State != PairingState.Unpaired)
            throw new InvalidOperationException($"Cannot request pairing from state {State}");

        State = PairingState.PairingRequested;
    }

    public void MarkPaired(TimeProvider timeProvider)
    {
        if (State != PairingState.PairingRequested)
            throw new InvalidOperationException($"Cannot mark paired from state {State}");

        State = PairingState.Paired;
        PairedAt = timeProvider.GetUtcNow();  // MH-004: never DateTime.UtcNow

        RaiseDomainEvent(new Events.DevicePaired { PublicKeyBase64 = PublicKeyBase64! });
    }

    public void Revoke()
    {
        State = PairingState.Revoked;
        PublicKeyBase64 = null;
        RaiseDomainEvent(new Events.DeviceUnpaired());
    }
}
