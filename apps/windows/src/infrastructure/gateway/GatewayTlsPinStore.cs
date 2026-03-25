using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace OpenClawWindows.Infrastructure.Gateway;

// TOFU (Trust On First Use) fingerprint store for node-session TLS certificates.
// Persists to %APPDATA%\OpenClaw\tls_pins.json; write-then-rename ensures atomicity.
internal sealed class GatewayTlsPinStore
{
    // Tunables
    private static readonly string PinFilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OpenClaw", "tls_pins.json");

    private readonly SemaphoreSlim _lock = new(1, 1);
    private Dictionary<string, string>? _pins;   // lazy-loaded; null until first access

    internal async Task<string?> LoadFingerprintAsync(string stableId, CancellationToken ct)
    {
        await EnsureLoadedAsync(ct);
        return _pins!.TryGetValue(stableId, out var fp) ? fp : null;
    }

    internal async Task StoreFingerprintAsync(string stableId, string fingerprint, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            await EnsureLoadedLockedAsync(ct);
            _pins![stableId] = fingerprint;
            await PersistLockedAsync(ct);
        }
        finally { _lock.Release(); }
    }

    // SHA-256 of the raw DER bytes — returned as uppercase hex.
    internal static string ComputeFingerprint(X509Certificate cert)
    {
        var hash = SHA256.HashData(cert.GetRawCertData());
        return Convert.ToHexString(hash);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async Task EnsureLoadedAsync(CancellationToken ct)
    {
        if (_pins is not null) return;
        await _lock.WaitAsync(ct);
        try { await EnsureLoadedLockedAsync(ct); }
        finally { _lock.Release(); }
    }

    private async Task EnsureLoadedLockedAsync(CancellationToken ct)
    {
        if (_pins is not null) return;

        if (!File.Exists(PinFilePath))
        {
            _pins = [];
            return;
        }

        try
        {
            await using var fs = File.OpenRead(PinFilePath);
            _pins = await JsonSerializer.DeserializeAsync<Dictionary<string, string>>(fs, cancellationToken: ct) ?? [];
        }
        catch
        {
            // Treat corrupt/unreadable pin file as empty — next TOFU will re-pin
            _pins = [];
        }
    }

    private async Task PersistLockedAsync(CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(PinFilePath)!;
        Directory.CreateDirectory(dir);

        var tmp = PinFilePath + ".tmp";
        await using (var fs = File.Create(tmp))
        {
            await JsonSerializer.SerializeAsync(fs, _pins, cancellationToken: ct);
        }

        // Atomic rename so a crash mid-write never corrupts existing pins
        File.Move(tmp, PinFilePath, overwrite: true);
    }
}
