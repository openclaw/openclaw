using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.PortManagement;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Process;

public sealed class PortGuardianTests
{
    // ── ParseNetstatOutput — mirrors Swift: _testParseListeners ───────────────

    [Fact]
    public void ParseListeners_IPv4Entry_ExtractsPid()
    {
        // Standard netstat -ano line for TCP LISTENING
        const string text =
            "  Proto  Local Address          Foreign Address        State           PID\n" +
            "  TCP    0.0.0.0:18789          0.0.0.0:0              LISTENING       9999\n";

        var result = PortGuardian.TestParseListeners(text, 18789);

        Assert.Single(result);
        Assert.Equal(9999, result[0].Pid);
    }

    [Fact]
    public void ParseListeners_IPv6Entry_ExtractsPid()
    {
        // IPv6 LISTENING entry — port after last colon in "[::]:18789"
        const string text =
            "  TCP    [::]:18789             [::]:0                 LISTENING       9999\n";

        var result = PortGuardian.TestParseListeners(text, 18789);

        Assert.Single(result);
        Assert.Equal(9999, result[0].Pid);
    }

    [Fact]
    public void ParseListeners_DuplicatePidIPv4AndIPv6_DeduplicatesToSingleEntry()
    {
        // Same PID bound on both 0.0.0.0 and [::] → deduplicated to one entry
        const string text =
            "  TCP    0.0.0.0:18789          0.0.0.0:0              LISTENING       9999\n" +
            "  TCP    [::]:18789             [::]:0                 LISTENING       9999\n";

        var result = PortGuardian.TestParseListeners(text, 18789);

        Assert.Single(result);
        Assert.Equal(9999, result[0].Pid);
    }

    [Fact]
    public void ParseListeners_WrongPort_ReturnsEmpty()
    {
        // Port 8080 in output; we ask for 18789 → nothing
        const string text =
            "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       9999\n";

        var result = PortGuardian.TestParseListeners(text, 18789);

        Assert.Empty(result);
    }

    [Fact]
    public void ParseListeners_NotListeningState_Skipped()
    {
        // ESTABLISHED connection on the port → should not be included
        const string text =
            "  TCP    0.0.0.0:18789          192.168.1.1:12345      ESTABLISHED     9999\n";

        var result = PortGuardian.TestParseListeners(text, 18789);

        Assert.Empty(result);
    }

    [Fact]
    public void ParseListeners_UdpEntry_Skipped()
    {
        // UDP entries must be ignored
        const string text =
            "  UDP    0.0.0.0:18789          *:*                                    9999\n";

        var result = PortGuardian.TestParseListeners(text, 18789);

        Assert.Empty(result);
    }

    [Fact]
    public void ParseListeners_EmptyText_ReturnsEmpty()
    {
        var result = PortGuardian.TestParseListeners("", 18789);
        Assert.Empty(result);
    }

    [Fact]
    public void ParseListeners_TwoDistinctProcesses_ReturnsBoth()
    {
        // Two different PIDs on the same port (unusual but must not be dropped)
        const string text =
            "  TCP    0.0.0.0:18789          0.0.0.0:0              LISTENING       1111\n" +
            "  TCP    127.0.0.1:18789        0.0.0.0:0              LISTENING       2222\n";

        var result = PortGuardian.TestParseListeners(text, 18789);

        Assert.Equal(2, result.Count);
        Assert.Contains(result, r => r.Pid == 1111);
        Assert.Contains(result, r => r.Pid == 2222);
    }

    // ── BuildReport — mirrors Swift: _testBuildReport ─────────────────────────

    [Fact]
    public void BuildReport_NoListeners_ReturnsMissingStatus()
    {
        // mirrors Swift: listeners.isEmpty → .missing
        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Local, []);

        Assert.IsType<PortReportStatus.Missing>(report.Status);
        Assert.Contains("Nothing is listening", report.Summary);
        Assert.Empty(report.Listeners);
    }

    [Fact]
    public void BuildReport_LocalMode_NodeProcess_ReturnsOk()
    {
        // mirrors Swift: local mode + "node" command → ok
        var listeners = new List<(int, string, string, string?)>
        {
            (1234, "node", "/usr/bin/node", null),
        };

        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Local, listeners);

        Assert.IsType<PortReportStatus.Ok>(report.Status);
        Assert.All(report.Listeners, l => Assert.True(l.Expected));
        Assert.Empty(report.Offenders);
    }

    [Fact]
    public void BuildReport_LocalMode_GatewayDaemonInFullCommand_ReturnsOk()
    {
        // mirrors Swift: full.contains("gateway-daemon") → expected
        var listeners = new List<(int, string, string, string?)>
        {
            (1234, "openclaw", "/usr/local/bin/openclaw gateway-daemon", null),
        };

        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Local, listeners);

        Assert.IsType<PortReportStatus.Ok>(report.Status);
        Assert.True(report.Listeners[0].Expected);
    }

    [Fact]
    public void BuildReport_LocalMode_UnknownProcess_ReturnsInterference()
    {
        // mirrors Swift: unexpected process on gateway port → .interference
        var listeners = new List<(int, string, string, string?)>
        {
            (5678, "python", "C:\\python.exe", null),
        };

        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Local, listeners);

        Assert.IsType<PortReportStatus.Interference>(report.Status);
        Assert.Single(report.Offenders);
        Assert.Equal(5678, report.Offenders[0].Pid);
        Assert.Contains("5678", report.Summary);
    }

    [Fact]
    public void BuildReport_RemoteMode_SshProcess_ReturnsOk()
    {
        // mirrors Swift: remote mode + "ssh" command → ok
        var listeners = new List<(int, string, string, string?)>
        {
            (2222, "ssh", "C:\\ssh.exe", null),
        };

        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Remote, listeners);

        Assert.IsType<PortReportStatus.Ok>(report.Status);
        Assert.True(report.Listeners[0].Expected);
    }

    [Fact]
    public void BuildReport_RemoteMode_NonSshProcess_ReturnsInterference()
    {
        // mirrors Swift: remote mode + non-ssh command → .interference
        var listeners = new List<(int, string, string, string?)>
        {
            (3333, "node", "/usr/bin/node", null),
        };

        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Remote, listeners);

        Assert.IsType<PortReportStatus.Interference>(report.Status);
        Assert.Single(report.Offenders);
    }

    [Fact]
    public void BuildReport_UnconfiguredMode_NoListeners_ReturnsEmpty()
    {
        // mirrors Swift: mode == .unconfigured → diagnose returns []
        // (BuildReport for unconfigured with listeners: okPredicate = _ => false → all offenders)
        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Unconfigured, []);

        Assert.IsType<PortReportStatus.Missing>(report.Status);
    }

    [Fact]
    public void BuildReport_MixedListeners_SeparatesExpectedAndOffenders()
    {
        // One expected (node) + one unexpected (python) in local mode
        var listeners = new List<(int, string, string, string?)>
        {
            (1111, "node",   "/usr/bin/node",   null),
            (2222, "python", "C:\\python.exe",  null),
        };

        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Local, listeners);

        Assert.IsType<PortReportStatus.Interference>(report.Status);
        Assert.Single(report.Offenders);
        Assert.Equal(2222, report.Offenders[0].Pid);
        Assert.Equal(2, report.Listeners.Count);
    }

    [Fact]
    public void BuildReport_Summary_ContainsPortAndProcess()
    {
        // Summary text must mention port and process — mirrors Swift string format
        var listeners = new List<(int, string, string, string?)>
        {
            (1234, "node", "/usr/bin/node", null),
        };

        var report = PortGuardian.TestBuildReport(18789, ConnectionMode.Local, listeners);

        Assert.Contains("18789", report.Summary);
        Assert.Contains("node", report.Summary);
    }
}
