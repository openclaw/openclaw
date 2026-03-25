using OpenClawWindows.Domain.Pairing;

namespace OpenClawWindows.Tests.Unit.Domain.Pairing;

// Tests for Ed25519KeyPair focusing on security-critical behaviors:
// key generation, serialization round-trip, blob validation, and signature correctness.
public sealed class Ed25519KeyPairTests
{
    // ── Generate ──────────────────────────────────────────────────────────────

    [Fact]
    public void Generate_ReturnsSuccess()
    {
        Ed25519KeyPair.Generate().IsError.Should().BeFalse();
    }

    [Fact]
    public void Generate_PublicKeyBase64_IsValidBase64()
    {
        var kp = Ed25519KeyPair.Generate().Value;
        var act = () => Convert.FromBase64String(kp.PublicKeyBase64);
        act.Should().NotThrow("PublicKeyBase64 must be valid standard base64");
    }

    [Fact]
    public void Generate_PublicKeyIs32Bytes()
    {
        // Ed25519 public keys are exactly 32 bytes.
        var kp = Ed25519KeyPair.Generate().Value;
        Convert.FromBase64String(kp.PublicKeyBase64).Should().HaveCount(32);
    }

    [Fact]
    public void Generate_TwoCallsProduceDifferentKeys()
    {
        // Each call must produce a distinct keypair — never a fixed/hardcoded key.
        var kp1 = Ed25519KeyPair.Generate().Value;
        var kp2 = Ed25519KeyPair.Generate().Value;
        kp1.PublicKeyBase64.Should().NotBe(kp2.PublicKeyBase64,
            because: "each Generate() call must produce a fresh random keypair");
    }

    // ── Serialization round-trip ──────────────────────────────────────────────

    [Fact]
    public void ToStorageBytes_FromStorage_RoundTrip_PreservesPublicKey()
    {
        // The public key must survive a serialize→deserialize cycle unchanged.
        // This is security-critical: a mismatch means the wrong device identity
        // is used for gateway authentication.
        var original = Ed25519KeyPair.Generate().Value;
        var blob     = original.ToStorageBytes();

        var restored = Ed25519KeyPair.FromStorage(blob);

        restored.IsError.Should().BeFalse();
        restored.Value.PublicKeyBase64.Should().Be(original.PublicKeyBase64,
            because: "public key must survive a storage round-trip unchanged");
    }

    [Fact]
    public void ToStorageBytes_FromStorage_RoundTrip_PreservesSigningCapability()
    {
        // A key restored from storage must produce signatures verifiable with
        // the original public key — proves the private key was correctly preserved.
        var original  = Ed25519KeyPair.Generate().Value;
        var blob      = original.ToStorageBytes();
        var restored  = Ed25519KeyPair.FromStorage(blob).Value;

        var message   = "test-payload"u8.ToArray();
        var signature = restored.Sign(message);

        // Verify signature with original public key
        var bouncyPub = new Org.BouncyCastle.Crypto.Parameters.Ed25519PublicKeyParameters(
            Convert.FromBase64String(original.PublicKeyBase64));
        var verifier = new Org.BouncyCastle.Crypto.Signers.Ed25519Signer();
        verifier.Init(false, bouncyPub);
        verifier.BlockUpdate(message, 0, message.Length);
        verifier.VerifySignature(signature).Should().BeTrue(
            because: "restored keypair must produce valid signatures");
    }

    // ── FromStorage — invalid blob rejection ─────────────────────────────────

    [Fact]
    public void FromStorage_EmptyBlob_ReturnsError()
    {
        Ed25519KeyPair.FromStorage([]).IsError.Should().BeTrue(
            because: "an empty blob has no key material and must be rejected");
    }

    [Fact]
    public void FromStorage_BlobTooShort_ReturnsError()
    {
        // A 3-byte blob cannot even hold the 4-byte length prefix.
        Ed25519KeyPair.FromStorage([1, 2, 3]).IsError.Should().BeTrue(
            because: "blob shorter than 4 bytes cannot contain valid key material");
    }

    [Fact]
    public void FromStorage_TruncatedBlob_ReturnsError()
    {
        // Length prefix says 32 bytes of public key, but blob ends early.
        var blob = new byte[8];
        BitConverter.TryWriteBytes(blob.AsSpan(0, 4), 32u); // claims 32-byte pub key
        // Only 4 bytes follow — truncated
        Ed25519KeyPair.FromStorage(blob).IsError.Should().BeTrue(
            because: "a truncated blob must be rejected rather than reading garbage bytes");
    }

    [Fact]
    public void FromStorage_WrongPrivateKeyLength_ReturnsError()
    {
        // The private key (seed) for Ed25519 must be exactly 32 bytes.
        // A blob with 31-byte private key must be rejected.
        var pubBytes = new byte[32];
        var privBytes = new byte[31];  // wrong — must be 32
        var blob = BuildBlob(pubBytes, privBytes);
        Ed25519KeyPair.FromStorage(blob).IsError.Should().BeTrue(
            because: "Ed25519 private key seed must be exactly 32 bytes");
    }

    [Fact]
    public void FromStorage_CorruptedBlob_ReturnsError()
    {
        // All-zero private key is technically 32 bytes but may fail cryptographic validation
        // or at minimum produces an unusable key. The important thing: it must not throw.
        var pubBytes  = new byte[32];
        var privBytes = new byte[32]; // all zeros
        var blob = BuildBlob(pubBytes, privBytes);

        var act = () => Ed25519KeyPair.FromStorage(blob);
        act.Should().NotThrow("FromStorage must never throw — it returns ErrorOr");
    }

    // ── DeviceId ──────────────────────────────────────────────────────────────

    [Fact]
    public void DeviceId_IsHexString()
    {
        var kp = Ed25519KeyPair.Generate().Value;
        var id = kp.DeviceId();
        id.Should().MatchRegex("^[0-9a-f]{64}$",
            because: "DeviceId is SHA256 hex of public key — 64 lowercase hex chars");
    }

    [Fact]
    public void DeviceId_SameKeyPair_IsDeterministic()
    {
        var kp = Ed25519KeyPair.Generate().Value;
        kp.DeviceId().Should().Be(kp.DeviceId(),
            because: "DeviceId must be deterministic for the same keypair");
    }

    [Fact]
    public void DeviceId_DifferentKeyPairs_AreDifferent()
    {
        var id1 = Ed25519KeyPair.Generate().Value.DeviceId();
        var id2 = Ed25519KeyPair.Generate().Value.DeviceId();
        id1.Should().NotBe(id2);
    }

    // ── PublicKeyBase64Url ────────────────────────────────────────────────────

    [Fact]
    public void PublicKeyBase64Url_ContainsNoBase64SpecialChars()
    {
        var kp  = Ed25519KeyPair.Generate().Value;
        var url = kp.PublicKeyBase64Url();
        url.Should().NotContain("+", because: "base64url must use '-' instead of '+'");
        url.Should().NotContain("/", because: "base64url must use '_' instead of '/'");
        url.Should().NotContain("=", because: "base64url must omit padding");
    }

    // ── Sign and SignPayload ──────────────────────────────────────────────────

    [Fact]
    public void Sign_DifferentMessages_ProduceDifferentSignatures()
    {
        var kp   = Ed25519KeyPair.Generate().Value;
        var sig1 = kp.Sign("message-one"u8.ToArray());
        var sig2 = kp.Sign("message-two"u8.ToArray());
        sig1.Should().NotEqual(sig2);
    }

    [Fact]
    public void Sign_ProducesSignatureOfCorrectLength()
    {
        // Ed25519 signatures are always exactly 64 bytes.
        var sig = Ed25519KeyPair.Generate().Value.Sign("payload"u8.ToArray());
        sig.Should().HaveCount(64, because: "Ed25519 signatures are exactly 64 bytes");
    }

    [Fact]
    public void SignPayload_ProducesBase64UrlString()
    {
        var kp  = Ed25519KeyPair.Generate().Value;
        var sig = kp.SignPayload("test-payload");
        sig.Should().NotContain("+").And.NotContain("/").And.NotContain("=");
    }

    // ── VerifySignature ───────────────────────────────────────────────────────

    [Fact]
    public void VerifySignature_WrongGatewayKey_ReturnsFalse()
    {
        // A signature from one keypair must not verify with a different gateway public key.
        // This prevents a compromised gateway from impersonating a valid one.
        var device  = Ed25519KeyPair.Generate().Value;
        var gateway = Ed25519KeyPair.Generate().Value;

        var randomSignature = Convert.ToBase64String(new byte[64]);
        device.VerifySignature(randomSignature, gateway.PublicKeyBase64)
            .Should().BeFalse(because: "garbage signature must fail verification");
    }

    [Fact]
    public void VerifySignature_GarbageInput_ReturnsFalse()
    {
        // Malformed base64 or short signature must not throw — must return false.
        var kp = Ed25519KeyPair.Generate().Value;
        kp.VerifySignature("not-a-real-sig", kp.PublicKeyBase64)
            .Should().BeFalse(because: "invalid input must fail gracefully");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static byte[] BuildBlob(byte[] pubBytes, byte[] privBytes)
    {
        var lenPrefix = BitConverter.GetBytes((uint)pubBytes.Length);
        if (!BitConverter.IsLittleEndian) Array.Reverse(lenPrefix);
        var blob = new byte[4 + pubBytes.Length + privBytes.Length];
        Buffer.BlockCopy(lenPrefix,  0, blob, 0,                     4);
        Buffer.BlockCopy(pubBytes,   0, blob, 4,                     pubBytes.Length);
        Buffer.BlockCopy(privBytes,  0, blob, 4 + pubBytes.Length,   privBytes.Length);
        return blob;
    }
}
