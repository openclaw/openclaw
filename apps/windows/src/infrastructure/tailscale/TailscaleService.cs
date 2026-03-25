using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenClawWindows.Infrastructure.Tailscale;

internal sealed class TailscaleService : ITailscaleService
{
    // Tunables
    private static readonly Uri ApiEndpoint = new("http://100.100.100.100/api/data");
    private const int ApiTimeoutSeconds = 5;
    // Tailscale CGNAT range: 100.64.0.0/10
    private static readonly IPAddress CidrBase = IPAddress.Parse("100.64.0.0");
    private const int CidrBits = 10;

    private readonly ILogger<TailscaleService> _logger;
    private readonly IHttpClientFactory _http;

    public bool IsInstalled { get; private set; }
    public bool IsRunning { get; private set; }
    public string? TailscaleHostname { get; private set; }
    public string? TailscaleIP { get; private set; }
    public string? StatusError { get; private set; }

    public event EventHandler? IPChanged;

    public TailscaleService(ILogger<TailscaleService> logger, IHttpClientFactory http)
    {
        _logger = logger;
        _http = http;
    }

    public async Task CheckStatusAsync(CancellationToken ct = default)
    {
        var previousIP = TailscaleIP;
        IsInstalled = CheckInstallation();

        if (!IsInstalled)
        {
            IsRunning = false;
            TailscaleHostname = null;
            TailscaleIP = null;
            StatusError = "Tailscale is not installed";
        }
        else if (await FetchApiAsync(ct) is { } r)
        {
            IsRunning = r.Status.Equals("running", StringComparison.OrdinalIgnoreCase);
            if (IsRunning)
            {
                var device = r.DeviceName
                    .ToLowerInvariant()
                    .Replace(" ", "-", StringComparison.Ordinal);
                var tailnet = r.TailnetName
                    .Replace(".ts.net", "", StringComparison.OrdinalIgnoreCase)
                    .Replace(".tailscale.net", "", StringComparison.OrdinalIgnoreCase);

                TailscaleHostname = $"{device}.{tailnet}.ts.net";
                TailscaleIP = r.IPv4;
                StatusError = null;
                _logger.LogInformation(
                    "Tailscale running host={Host} ip={IP}", TailscaleHostname, TailscaleIP);
            }
            else
            {
                TailscaleHostname = null;
                TailscaleIP = null;
                StatusError = "Tailscale is not running";
            }
        }
        else
        {
            IsRunning = false;
            TailscaleHostname = null;
            TailscaleIP = null;
            StatusError = "Please start the Tailscale app";
            _logger.LogDebug("Tailscale API not responding; app likely not running");
        }

        // Fallback: scan adapters for a 100.64.0.0/10 address
        if (TailscaleIP is null)
        {
            var fallback = DetectTailnetIPv4();
            if (fallback is not null)
            {
                TailscaleIP = fallback;
                if (!IsRunning) IsRunning = true;
                StatusError = null;
                _logger.LogInformation("Tailscale adapter IP detected (fallback) ip={IP}", fallback);
            }
        }

        if (previousIP != TailscaleIP)
            IPChanged?.Invoke(this, EventArgs.Empty);
    }

    public void OpenTailscaleApp()
    {
        var exePath = TailscaleExePath();
        if (exePath is not null)
        {
            System.Diagnostics.Process.Start(
                new System.Diagnostics.ProcessStartInfo(exePath) { UseShellExecute = true });
        }
    }

    public void OpenDownloadPage()
    {
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = "https://tailscale.com/download/windows",
            UseShellExecute = true,
        });
    }

    public void OpenSetupGuide()
    {
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = "https://tailscale.com/kb/1017/install/",
            UseShellExecute = true,
        });
    }

    private bool CheckInstallation()
    {
        var installed = TailscaleExePath() is not null;
        _logger.LogDebug("Tailscale installed={Installed}", installed);
        return installed;
    }

    private static string? TailscaleExePath()
    {
        // Check both 64-bit and 32-bit Program Files
        foreach (var folder in new[]
        {
            Environment.SpecialFolder.ProgramFiles,
            Environment.SpecialFolder.ProgramFilesX86,
        })
        {
            var path = Path.Combine(
                Environment.GetFolderPath(folder), "Tailscale", "tailscale.exe");
            if (File.Exists(path)) return path;
        }

        return null;
    }

    private async Task<ApiResponse?> FetchApiAsync(CancellationToken ct)
    {
        try
        {
            var client = _http.CreateClient("tailscale");
            using var response = await client.GetAsync(ApiEndpoint, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Tailscale API returned {Status}", response.StatusCode);
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            return await JsonSerializer.DeserializeAsync<ApiResponse>(stream, JsonOptions, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            _logger.LogDebug(ex, "Failed to fetch Tailscale API status");
            return null;
        }
    }

    private static string? DetectTailnetIPv4()
    {
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;

            foreach (var addr in nic.GetIPProperties().UnicastAddresses)
            {
                if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                if (IsInTailscaleCidr(addr.Address))
                    return addr.Address.ToString();
            }
        }

        return null;
    }

    private static bool IsInTailscaleCidr(IPAddress address)
    {
        var addrBytes = address.GetAddressBytes();
        var baseBytes = CidrBase.GetAddressBytes();
        var remaining = CidrBits;

        for (var i = 0; i < 4 && remaining > 0; i++)
        {
            var bits = Math.Min(remaining, 8);
            var mask = (byte)(0xFF << (8 - bits));
            if ((addrBytes[i] & mask) != (baseBytes[i] & mask)) return false;
            remaining -= bits;
        }

        return true;
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private sealed class ApiResponse
    {
        [JsonPropertyName("Status")]
        public string Status { get; set; } = string.Empty;

        [JsonPropertyName("DeviceName")]
        public string DeviceName { get; set; } = string.Empty;

        [JsonPropertyName("TailnetName")]
        public string TailnetName { get; set; } = string.Empty;

        [JsonPropertyName("IPv4")]
        public string? IPv4 { get; set; }
    }
}
