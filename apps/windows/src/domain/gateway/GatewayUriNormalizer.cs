using System.Net;
using System.Net.Sockets;

namespace OpenClawWindows.Domain.Gateway;

// Enforces the gateway URL contract: ws:// for loopback-only, wss:// for any host.
internal static class GatewayUriNormalizer
{
    // Tunables
    private const int DefaultWsPort  = 18789;  // OpenClaw gateway default
    private const int DefaultWssPort = 443;

    /// <summary>
    /// Validates and normalizes a raw WebSocket URI string.
    /// Returns null for invalid input
    /// </summary>
    internal static string? Normalize(string? raw)
    {
        var trimmed = raw?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return null;

        var scheme = uri.Scheme.ToLowerInvariant();
        var host   = uri.Host.Trim();
        if (string.IsNullOrEmpty(host)) return null;

        if (scheme == "ws")
        {
            // ws:// is only valid for loopback
            if (!IsLoopbackHost(host)) return null;

            // Inject port 18789 when omitted.
            // uri.Port returns the scheme default (80) even when the port is absent —
            // check the authority string: port is explicit only when it appears as :<port>.
            if (uri.Authority.EndsWith($":{uri.Port}", StringComparison.Ordinal)) return uri.ToString();
            return new UriBuilder(uri) { Port = DefaultWsPort }.Uri.ToString();
        }

        if (scheme == "wss")
            return uri.ToString();

        return null;
    }

    internal static int DefaultPort(Uri uri) =>
        uri.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase) ? DefaultWssPort : DefaultWsPort;

    private static bool IsLoopbackHost(string host)
    {
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return true;
        if (host == "::1") return true;

        // 127.0.0.0/8 block
        if (IPAddress.TryParse(host, out var ip)
            && ip.AddressFamily == AddressFamily.InterNetwork
            && ip.GetAddressBytes()[0] == 127)
            return true;

        return false;
    }
}
