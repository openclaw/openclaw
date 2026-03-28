using System.Security.Cryptography;
using System.Text;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.DeepLinks;

// Persists the random unattended key in %APPDATA%\OpenClaw\deeplink_key.dat (DPAPI-encrypted).
internal sealed class FileSystemDeepLinkKeyStore : IDeepLinkKeyStore
{
    private static readonly string KeyPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OpenClaw", "deeplink_key.dat");

    private const DataProtectionScope DpapiScope = DataProtectionScope.CurrentUser;
    private static readonly byte[] KeyEntropy = "openclaw-deeplink-key-v1"u8.ToArray();

    private readonly SemaphoreSlim _lock = new(1, 1);
    private volatile string? _cached;

    public string GetOrCreateKey()
    {
        if (_cached is not null) return _cached;

        _lock.Wait();
        try
        {
            if (_cached is not null) return _cached;

            try
            {
                if (File.Exists(KeyPath))
                {
                    var blob = File.ReadAllBytes(KeyPath);
                    string existing;
                    try
                    {
                        existing = Encoding.UTF8.GetString(
                            ProtectedData.Unprotect(blob, KeyEntropy, DpapiScope)).Trim();
                    }
                    catch (CryptographicException)
                    {
                        // Pre-DPAPI migration: file may be plaintext — read as UTF-8 and re-encrypt.
                        existing = Encoding.UTF8.GetString(blob).Trim();
                        if (!string.IsNullOrEmpty(existing))
                        {
                            try
                            {
                                var enc = ProtectedData.Protect(
                                    Encoding.UTF8.GetBytes(existing), KeyEntropy, DpapiScope);
                                File.WriteAllBytes(KeyPath, enc);
                            }
                            catch { /* non-fatal; key valid for this session */ }
                        }
                    }
                    if (!string.IsNullOrEmpty(existing))
                        return _cached = existing;
                }
            }
            catch (IOException)
            {
                // Unreadable file — generate a new key.
            }

            var key = GenerateKey();
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(KeyPath)!);
                var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(key), KeyEntropy, DpapiScope);
                File.WriteAllBytes(KeyPath, encrypted);
            }
            catch { /* non-fatal; key still valid for this session */ }

            return _cached = key;
        }
        finally
        {
            _lock.Release();
        }
    }

    private static string GenerateKey()
    {
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }
}
