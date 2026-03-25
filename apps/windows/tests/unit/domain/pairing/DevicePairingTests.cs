namespace OpenClawWindows.Tests.Unit.Domain.Pairing;

public sealed class DevicePairingTests
{
    [Fact]
    public void Create_InitialState_IsUnpaired()
    {
        var pairing = DevicePairing.Create();

        pairing.State.Should().Be(PairingState.Unpaired);
        pairing.PublicKeyBase64.Should().BeNull();
    }

    [Fact]
    public void SetKeypair_StoresPublicKey()
    {
        var pairing = DevicePairing.Create();
        var kp = Ed25519KeyPair.Generate().Value;

        pairing.SetKeypair(kp);

        pairing.PublicKeyBase64.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void RequestPairing_FromUnpaired_Transitions()
    {
        var pairing = DevicePairing.Create();

        pairing.RequestPairing();

        pairing.State.Should().Be(PairingState.PairingRequested);
    }

    [Fact]
    public void RequestPairing_FromPaired_Throws()
    {
        var pairing = MakePaired();

        var act = () => pairing.RequestPairing();

        act.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void MarkPaired_AfterRequestPairing_SetsTimestamp()
    {
        var pairing = DevicePairing.Create();
        pairing.RequestPairing();

        pairing.MarkPaired(TimeProvider.System);

        pairing.State.Should().Be(PairingState.Paired);
        pairing.PairedAt.Should().NotBeNull();
    }

    [Fact]
    public void MarkPaired_RaisesDomainEvent()
    {
        var pairing = DevicePairing.Create();
        pairing.RequestPairing();

        pairing.MarkPaired(TimeProvider.System);

        pairing.DomainEvents.OfType<OpenClawWindows.Domain.Pairing.Events.DevicePaired>()
            .Should().ContainSingle();
    }

    [Fact]
    public void MarkPaired_WithoutRequest_Throws()
    {
        var pairing = DevicePairing.Create();

        var act = () => pairing.MarkPaired(TimeProvider.System);

        act.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void Revoke_ClearsPublicKey()
    {
        var pairing = MakePaired();

        pairing.Revoke();

        pairing.State.Should().Be(PairingState.Revoked);
        pairing.PublicKeyBase64.Should().BeNull();
    }

    [Fact]
    public void Revoke_RaisesDeviceUnpairedEvent()
    {
        var pairing = MakePaired();

        pairing.Revoke();

        pairing.DomainEvents.OfType<OpenClawWindows.Domain.Pairing.Events.DeviceUnpaired>()
            .Should().ContainSingle();
    }

    private static DevicePairing MakePaired()
    {
        var p = DevicePairing.Create();
        p.SetKeypair(Ed25519KeyPair.Generate().Value);
        p.RequestPairing();
        p.MarkPaired(TimeProvider.System);
        p.ClearDomainEvents();
        return p;
    }
}
