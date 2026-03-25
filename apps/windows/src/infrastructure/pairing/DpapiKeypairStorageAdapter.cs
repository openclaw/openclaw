using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Pairing;

namespace OpenClawWindows.Infrastructure.Pairing;

// DPAPI-encrypted keypair storage.
internal sealed class DpapiKeypairStorageAdapter : IKeypairStorage
{
    private readonly string _storagePath;
    private readonly ILogger<DpapiKeypairStorageAdapter> _logger;

    // CurrentUser scope — key is tied to the Windows account, never persists to disk unencrypted
    private const DataProtectionScope DpapiScope = DataProtectionScope.CurrentUser;
    private static readonly byte[] Entropy =
        "openclaw-keypair-v1"u8.ToArray(); // domain-binding entropy

    public DpapiKeypairStorageAdapter(ILogger<DpapiKeypairStorageAdapter> logger)
    {
        _logger = logger;
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var dir = Path.Combine(appData, "OpenClaw");
        Directory.CreateDirectory(dir);
        _storagePath = Path.Combine(dir, "keypair.dpapi");
    }

    public Task<bool> ExistsAsync(CancellationToken ct)
        => Task.FromResult(File.Exists(_storagePath));

    public async Task<ErrorOr<Ed25519KeyPair>> LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(_storagePath))
            return Error.NotFound("KEYPAIR_NOT_FOUND", "No keypair stored");

        try
        {
            var encrypted = await File.ReadAllBytesAsync(_storagePath, ct);
            var decrypted = ProtectedData.Unprotect(encrypted, Entropy, DpapiScope);
            return Ed25519KeyPair.FromStorage(decrypted);
        }
        catch (CryptographicException ex)
        {
            // DPAPI decrypt can fail if the user's Windows profile changed
            _logger.LogError(ex, "DPAPI decryption failed for keypair");
            return Error.Failure("KEYPAIR_DECRYPT_FAILED", ex.Message);
        }
    }

    public async Task SaveAsync(Ed25519KeyPair keyPair, CancellationToken ct)
    {
        // ToStorageBytes serializes public + private key material; DPAPI wraps the blob.
        var raw = keyPair.ToStorageBytes();
        var encrypted = ProtectedData.Protect(raw, Entropy, DpapiScope);

        var tmp = _storagePath + ".tmp";
        await File.WriteAllBytesAsync(tmp, encrypted, ct);
        File.Move(tmp, _storagePath, overwrite: true); // atomic rename
    }

    public Task DeleteAsync(CancellationToken ct)
    {
        if (File.Exists(_storagePath))
            File.Delete(_storagePath);
        return Task.CompletedTask;
    }
}
