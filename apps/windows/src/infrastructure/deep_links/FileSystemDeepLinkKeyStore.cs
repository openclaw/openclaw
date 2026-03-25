using System.Security.Cryptography;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.DeepLinks;

// Persists the random unattended key in %APPDATA%\OpenClaw\deeplink_key.dat.
internal sealed class FileSystemDeepLinkKeyStore : IDeepLinkKeyStore
{
    private static readonly string KeyPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OpenClaw", "deeplink_key.dat");

    private string? _cached;

    public string GetOrCreateKey()
    {
        if (_cached is not null) return _cached;

        try
        {
            if (File.Exists(KeyPath))
            {
                var existing = File.ReadAllText(KeyPath).Trim();
                if (!string.IsNullOrEmpty(existing))
                    return _cached = existing;
            }
        }
        catch { /* fall through to generate */ }

        var key = GenerateKey();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(KeyPath)!);
            File.WriteAllText(KeyPath, key);
        }
        catch { /* non-fatal; key still valid for this session */ }

        return _cached = key;
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
