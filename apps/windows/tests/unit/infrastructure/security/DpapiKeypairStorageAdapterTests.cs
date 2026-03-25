using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Domain.Pairing;
using OpenClawWindows.Infrastructure.Pairing;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Security;

// Integration tests for DpapiKeypairStorageAdapter.
// These tests exercise the real DPAPI stack and the filesystem.
// Any pre-existing keypair.dpapi is preserved: backed-up before each test,
// restored in the finally block so the user's pairing state is never lost.
public sealed class DpapiKeypairStorageAdapterTests : IDisposable
{
    private readonly DpapiKeypairStorageAdapter _sut;
    private readonly string                     _storagePath;
    private readonly byte[]?                    _originalBytes;

    public DpapiKeypairStorageAdapterTests()
    {
        _sut = new DpapiKeypairStorageAdapter(NullLogger<DpapiKeypairStorageAdapter>.Instance);

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        _storagePath = Path.Combine(appData, "OpenClaw", "keypair.dpapi");

        // Back up any existing keypair so we can restore it after the tests.
        _originalBytes = File.Exists(_storagePath) ? File.ReadAllBytes(_storagePath) : null;

        // Start from a clean slate.
        if (File.Exists(_storagePath))
            File.Delete(_storagePath);
    }

    public void Dispose()
    {
        // Restore the original keypair regardless of test outcome.
        if (_originalBytes is not null)
            File.WriteAllBytes(_storagePath, _originalBytes);
        else if (File.Exists(_storagePath))
            File.Delete(_storagePath);
    }

    // ── Exists ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task ExistsAsync_WhenNoFile_ReturnsFalse()
    {
        (await _sut.ExistsAsync(default)).Should().BeFalse();
    }

    [Fact]
    public async Task ExistsAsync_AfterSave_ReturnsTrue()
    {
        var kp = Ed25519KeyPair.Generate().Value;
        await _sut.SaveAsync(kp, default);

        (await _sut.ExistsAsync(default)).Should().BeTrue();
    }

    // ── Save + Load round-trip ─────────────────────────────────────────────────

    [Fact]
    public async Task SaveAsync_LoadAsync_RoundTrip_PreservesPublicKey()
    {
        // The public key identity must survive DPAPI encryption+decryption.
        // If it changes, the device appears as a different peer to the gateway.
        var original = Ed25519KeyPair.Generate().Value;
        await _sut.SaveAsync(original, default);

        var loaded = await _sut.LoadAsync(default);

        loaded.IsError.Should().BeFalse();
        loaded.Value.PublicKeyBase64.Should().Be(original.PublicKeyBase64,
            because: "DPAPI round-trip must preserve the public key exactly");
    }

    [Fact]
    public async Task SaveAsync_LoadAsync_RoundTrip_PreservesSigningCapability()
    {
        // The restored key must produce signatures that verify against the original public key.
        var original = Ed25519KeyPair.Generate().Value;
        await _sut.SaveAsync(original, default);
        var restored = (await _sut.LoadAsync(default)).Value;

        var message   = "gateway-challenge"u8.ToArray();
        var signature = restored.Sign(message);

        var pub      = new Org.BouncyCastle.Crypto.Parameters.Ed25519PublicKeyParameters(
            Convert.FromBase64String(original.PublicKeyBase64));
        var verifier = new Org.BouncyCastle.Crypto.Signers.Ed25519Signer();
        verifier.Init(false, pub);
        verifier.BlockUpdate(message, 0, message.Length);
        verifier.VerifySignature(signature).Should().BeTrue(
            because: "DPAPI round-trip must preserve the private key signing capability");
    }

    [Fact]
    public async Task SaveAsync_OverwritesPreviousKeypair()
    {
        var kp1 = Ed25519KeyPair.Generate().Value;
        var kp2 = Ed25519KeyPair.Generate().Value;

        await _sut.SaveAsync(kp1, default);
        await _sut.SaveAsync(kp2, default);

        var loaded = (await _sut.LoadAsync(default)).Value;
        loaded.PublicKeyBase64.Should().Be(kp2.PublicKeyBase64,
            because: "the second save must atomically overwrite the first");
    }

    // ── Load when missing ──────────────────────────────────────────────────────

    [Fact]
    public async Task LoadAsync_WhenNoFile_ReturnsNotFoundError()
    {
        var result = await _sut.LoadAsync(default);

        result.IsError.Should().BeTrue();
        result.FirstError.Type.Should().Be(ErrorOr.ErrorType.NotFound);
    }

    // ── Delete ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task DeleteAsync_AfterSave_FileIsGone()
    {
        var kp = Ed25519KeyPair.Generate().Value;
        await _sut.SaveAsync(kp, default);

        await _sut.DeleteAsync(default);

        (await _sut.ExistsAsync(default)).Should().BeFalse();
    }

    [Fact]
    public async Task DeleteAsync_WhenNoFile_DoesNotThrow()
    {
        var act = async () => await _sut.DeleteAsync(default);
        await act.Should().NotThrowAsync("DeleteAsync must be idempotent");
    }

    // ── Corrupt file ──────────────────────────────────────────────────────────

    [Fact]
    public async Task LoadAsync_CorruptFile_ReturnsFailureError()
    {
        // If the DPAPI-encrypted blob is corrupt (e.g. bit rot or profile migration),
        // LoadAsync must return an error rather than throwing, so the caller can
        // prompt the user to re-pair rather than crashing.
        await File.WriteAllBytesAsync(_storagePath, [0xDE, 0xAD, 0xBE, 0xEF]);

        var result = await _sut.LoadAsync(default);

        result.IsError.Should().BeTrue(
            because: "a corrupt DPAPI blob must produce a failure error, not an exception");
    }
}
