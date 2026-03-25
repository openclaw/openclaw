using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace OpenClawWindows.Domain.Os;

/// <summary>
/// Utility for reading system-level presence information.
/// </summary>
public static class SystemPresenceInfo
{
    // ── Last input ────────────────────────────────────────────────────────────

    // Seconds elapsed since the last keyboard/mouse/touch input event.
    // Returns null when the value cannot be determined (NaN, infinite, or negative idle time).
    public static int? LastInputSeconds()
    {
        var info = new LastInputInfo { CbSize = (uint)Marshal.SizeOf<LastInputInfo>() };
        if (!GetLastInputInfo(ref info)) return null;

        // TickCount wraps at ~49 days; unchecked subtraction handles the wraparound correctly.
        var idleMs = unchecked((uint)Environment.TickCount - info.DwTime);
        var seconds = idleMs / 1000.0;

        if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0) return null;

        return (int)Math.Round(seconds);
    }

    // ── Primary IPv4 ──────────────────────────────────────────────────────────

    // Returns the primary IPv4 address of this machine.
    // Algorithm:
    //   - Iterate all up, non-loopback, non-tunnel IPv4 interfaces.
    //   - Prefer Ethernet (analogous to macOS "en0").
    //   - Fall back to the first available IPv4 address.
    public static string? PrimaryIPv4Address()
    {
        string? fallback = null;
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;

                var ipv4 = ni.GetIPProperties().UnicastAddresses
                    .FirstOrDefault(ua => ua.Address.AddressFamily == AddressFamily.InterNetwork);

                if (ipv4 is null) continue;

                // Prefer Ethernet — closest semantic to macOS "en0" preference
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Ethernet)
                    return ipv4.Address.ToString();

                fallback ??= ipv4.Address.ToString();
            }
        }
        catch (NetworkInformationException)
        {
            return null;
        }

        return fallback;
    }

    // ── P/Invoke ──────────────────────────────────────────────────────────────

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LastInputInfo plii);

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint CbSize;
        public uint DwTime;
    }
}
