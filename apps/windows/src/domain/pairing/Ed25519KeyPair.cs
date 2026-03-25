using System.Security.Cryptography;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

namespace OpenClawWindows.Domain.Pairing;

/// <summary>
/// Ed25519 keypair for gateway authentication.
/// Resolved SPIKE-002: implemented with BouncyCastle.Cryptography (pure .NET, ARM64-safe).
/// </summary>
public sealed class Ed25519KeyPair
{
    public string PublicKeyBase64 { get; }

    // Private key bytes are not exposed as a public property — intentional invariant.
    // Holds the 32-byte Ed25519 seed (BouncyCastle GetEncoded() convention).
    private readonly byte[] _privateKey;

    private Ed25519KeyPair(string publicKeyBase64, byte[] privateKey)
    {
        PublicKeyBase64 = publicKeyBase64;
        _privateKey = privateKey;
    }

    public static ErrorOr<Ed25519KeyPair> Generate()
    {
        try
        {
            var generator = new Ed25519KeyPairGenerator();
            generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
            var kp = generator.GenerateKeyPair();

            var priv = (Ed25519PrivateKeyParameters)kp.Private;
            var pub  = (Ed25519PublicKeyParameters)kp.Public;

            return new Ed25519KeyPair(
                Convert.ToBase64String(pub.GetEncoded()),
                priv.GetEncoded()); // 32-byte seed
        }
        catch (Exception ex)
        {
            return Error.Failure("ED25519.GENERATE_FAILED", ex.Message);
        }
    }

    public static ErrorOr<Ed25519KeyPair> FromStorage(byte[] blob)
    {
        Guard.Against.Null(blob, nameof(blob));

        try
        {
            if (blob.Length < 4)
                return Error.Failure("ED25519.BLOB_INVALID", "Blob too short");

            var lenBytes = blob[0..4];
            if (!BitConverter.IsLittleEndian) Array.Reverse(lenBytes);
            var pubLen = (int)BitConverter.ToUInt32(lenBytes, 0);

            if (blob.Length < 4 + pubLen)
                return Error.Failure("ED25519.BLOB_INVALID", "Blob truncated");

            var pubBytes  = blob[4..(4 + pubLen)];
            var privBytes = blob[(4 + pubLen)..];

            if (privBytes.Length != 32)
                return Error.Failure("ED25519.BLOB_INVALID", "Private key must be 32 bytes");

            return new Ed25519KeyPair(Convert.ToBase64String(pubBytes), privBytes);
        }
        catch (Exception ex)
        {
            return Error.Failure("ED25519.DESERIALIZE_FAILED", ex.Message);
        }
    }

    public byte[] ToStorageBytes()
    {
        var pubBytes  = Convert.FromBase64String(PublicKeyBase64);
        var lenPrefix = BitConverter.GetBytes((uint)pubBytes.Length);
        if (!BitConverter.IsLittleEndian) Array.Reverse(lenPrefix);

        var result = new byte[4 + pubBytes.Length + _privateKey.Length];
        Buffer.BlockCopy(lenPrefix, 0, result, 0,                       4);
        Buffer.BlockCopy(pubBytes,  0, result, 4,                       pubBytes.Length);
        Buffer.BlockCopy(_privateKey, 0, result, 4 + pubBytes.Length,   _privateKey.Length);
        return result;
    }

    public byte[] Sign(byte[] message)
    {
        Guard.Against.Null(message, nameof(message));

        var privKey = new Ed25519PrivateKeyParameters(_privateKey);
        var signer  = new Ed25519Signer();
        signer.Init(true, privKey);
        signer.BlockUpdate(message, 0, message.Length);
        return signer.GenerateSignature();
    }

    // SHA256 hex of raw public key bytes — matches gateway's deriveDeviceIdFromPublicKey
    public string DeviceId()
    {
        var pubBytes = Convert.FromBase64String(PublicKeyBase64);
        var hash = SHA256.HashData(pubBytes);
        return Convert.ToHexStringLower(hash);
    }

    // Base64URL-encoded raw public key — matches gateway's normalizeDevicePublicKeyBase64Url
    public string PublicKeyBase64Url()
    {
        var pubBytes = Convert.FromBase64String(PublicKeyBase64);
        return Base64UrlEncode(pubBytes);
    }

    // Sign UTF-8 payload and return base64url signature — matches DeviceIdentityStore.signPayload
    public string SignPayload(string payload)
    {
        var message = System.Text.Encoding.UTF8.GetBytes(payload);
        var sig = Sign(message);
        return Base64UrlEncode(sig);
    }

    private static string Base64UrlEncode(byte[] data)
    {
        return Convert.ToBase64String(data)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    public bool VerifySignature(string signatureBase64, string gatewayPublicKeyBase64)
    {
        try
        {
            var sig      = Convert.FromBase64String(signatureBase64);
            var gwPubRaw = Convert.FromBase64String(gatewayPublicKeyBase64);
            // The message the gateway signed is this node's public key.
            var message  = Convert.FromBase64String(PublicKeyBase64);

            var gwPubKey  = new Ed25519PublicKeyParameters(gwPubRaw);
            var verifier  = new Ed25519Signer();
            verifier.Init(false, gwPubKey);
            verifier.BlockUpdate(message, 0, message.Length);
            return verifier.VerifySignature(sig);
        }
        catch
        {
            return false;
        }
    }
}
