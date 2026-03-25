using System.Net;
using System.Net.Sockets;

namespace OpenClawWindows.Infrastructure.Gateway;

internal static class LoopbackHost
{
    internal static bool IsLoopbackHost(string rawHost)
    {
        var host = rawHost
            .Trim()
            .ToLowerInvariant()
            .Trim('[', ']');

        if (host.EndsWith('.'))
            host = host[..^1];

        var zoneIndex = host.IndexOf('%');
        if (zoneIndex >= 0)
            host = host[..zoneIndex];

        if (string.IsNullOrEmpty(host))
            return false;

        if (host == "localhost" || host == "0.0.0.0" || host == "::")
            return true;

        if (!IPAddress.TryParse(host, out var addr))
            return false;

        if (addr.AddressFamily == AddressFamily.InterNetwork)
        {
            // IPv4 loopback: 127.0.0.0/8
            return addr.GetAddressBytes()[0] == 127;
        }

        if (addr.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var bytes = addr.GetAddressBytes();
            // ::1
            var isV6Loopback = bytes[..15].All(b => b == 0) && bytes[15] == 1;
            if (isV6Loopback) return true;
            // ::ffff:127.x.x.x (IPv4-mapped loopback)
            var isMappedV4 = bytes[..10].All(b => b == 0) && bytes[10] == 0xFF && bytes[11] == 0xFF;
            return isMappedV4 && bytes[12] == 127;
        }

        return false;
    }
}
