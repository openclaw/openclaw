using System.Net;
using OpenClawWindows.Domain.Os;

namespace OpenClawWindows.Tests.Unit.Domain.Os;

public sealed class SystemPresenceInfoTests
{
    // ── LastInputSeconds ──────────────────────────────────────────────────────

    [Fact]
    public void LastInputSeconds_ReturnsNullOrNonNegative()
    {
        // System call may return null only if GetLastInputInfo fails (rare on Windows)
        var result = SystemPresenceInfo.LastInputSeconds();

        if (result is not null)
            result.Value.Should().BeGreaterThanOrEqualTo(0);
    }

    [Fact]
    public void LastInputSeconds_ReturnsRoundedSeconds()
    {
        // Calling twice in quick succession must return the same value or differ by at most 1s
        var a = SystemPresenceInfo.LastInputSeconds();
        var b = SystemPresenceInfo.LastInputSeconds();

        if (a is null || b is null) return; // skip if system call unavailable
        Math.Abs(a.Value - b.Value).Should().BeLessThanOrEqualTo(1);
    }

    // ── PrimaryIPv4Address ────────────────────────────────────────────────────

    [Fact]
    public void PrimaryIPv4Address_ReturnsNullOrValidIpv4()
    {
        var result = SystemPresenceInfo.PrimaryIPv4Address();

        if (result is null) return; // acceptable when no network interface is up

        IPAddress.TryParse(result, out var addr).Should().BeTrue();
        addr!.AddressFamily.Should().Be(System.Net.Sockets.AddressFamily.InterNetwork);
    }

    [Fact]
    public void PrimaryIPv4Address_IsNotLoopback()
    {
        var result = SystemPresenceInfo.PrimaryIPv4Address();

        if (result is null) return;

        result.Should().NotBe("127.0.0.1");
        result.Should().NotStartWith("127.");
    }
}
