using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;
using OpenClawWindows.Infrastructure.Paths;

namespace OpenClawWindows.Infrastructure.PortManagement;

internal sealed class PortGuardianRecord
{
    [JsonPropertyName("port")]      public int    Port      { get; init; }
    [JsonPropertyName("pid")]       public int    Pid       { get; init; }
    [JsonPropertyName("command")]   public string Command   { get; init; } = "";
    [JsonPropertyName("mode")]      public string Mode      { get; init; } = "";
    [JsonPropertyName("timestamp")] public double Timestamp { get; init; }
}

internal sealed record PortGuardianDescriptor(int Pid, string Command, string? ExecutablePath);

internal sealed class PortReportListener
{
    public int     Pid         { get; init; }
    public string  Command     { get; init; } = "";
    public string  FullCommand { get; init; } = "";
    public string? User        { get; init; }
    public bool    Expected    { get; init; }
}

internal abstract class PortReportStatus
{
    internal sealed class Ok(string Text) : PortReportStatus
    {
        internal string Text { get; } = Text;
    }

    internal sealed class Missing(string Text) : PortReportStatus
    {
        internal string Text { get; } = Text;
    }

    internal sealed class Interference(string Text, IReadOnlyList<PortReportListener> Offenders) : PortReportStatus
    {
        internal string                           Text      { get; } = Text;
        internal IReadOnlyList<PortReportListener> Offenders { get; } = Offenders;
    }
}

internal sealed class PortReport
{
    public int                               Port      { get; init; }
    public string                            Expected  { get; init; } = "";
    public PortReportStatus                  Status    { get; init; } = new PortReportStatus.Missing("");
    public IReadOnlyList<PortReportListener> Listeners { get; init; } = [];

    public IReadOnlyList<PortReportListener> Offenders =>
        Status is PortReportStatus.Interference i ? i.Offenders : [];

    public string Summary => Status switch
    {
        PortReportStatus.Ok           ok  => ok.Text,
        PortReportStatus.Missing      m   => m.Text,
        PortReportStatus.Interference inf => inf.Text,
        _                                 => "",
    };
}

/// <summary>
/// Detects and terminates stray processes holding the gateway port; probes HTTP health; persists records.
/// </summary>
internal sealed class PortGuardian : IPortGuardian
{
    // Tunables
    private static readonly TimeSpan HealthProbeTimeout = TimeSpan.FromSeconds(2.0);
    private const int    ListenersTimeoutMs         = 5_000;
    private const int    KillGracePeriodMs          = 2_000;

    private static readonly string[] ExpectedLocalCommands = ["node", "openclaw", "tsx", "pnpm", "bun"];

    private readonly ILogger<PortGuardian> _logger;
    // SemaphoreSlim(1,1) guards _records mutations — async-compatible mutual exclusion.
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly List<PortGuardianRecord> _records;

    private static string RecordPath =>
        System.IO.Path.Combine(OpenClawPaths.StateDirPath, "port-guard.json");

    public PortGuardian(ILogger<PortGuardian> logger)
    {
        _logger  = logger;
        _records = LoadRecords(RecordPath);
    }

    public async Task SweepAsync(ConnectionMode mode)
    {
        _logger.LogInformation("port sweep starting (mode={Mode})", mode.ToString().ToLowerInvariant());
        if (mode == ConnectionMode.Unconfigured)
        {
            _logger.LogInformation("port sweep skipped (mode=unconfigured)");
            return;
        }

        var ports = new[] { GatewayEnvironment.GatewayPort() };
        foreach (var port in ports)
        {
            var listeners = await ListenersAsync(port).ConfigureAwait(false);
            if (listeners.Count == 0) continue;

            foreach (var listener in listeners)
            {
                if (IsExpected(listener, port, mode))
                {
                    _logger.LogInformation(
                        "port {Port} already served by expected {Command} (pid {Pid}) — keeping",
                        port, listener.Command, listener.Pid);
                    continue;
                }

                var killed = await KillAsync(listener.Pid).ConfigureAwait(false);
                if (killed)
                    _logger.LogError(
                        "port {Port} was held by {Command} (pid {Pid}); terminated",
                        port, listener.Command, listener.Pid);
                else
                    _logger.LogError(
                        "failed to terminate pid {Pid} on port {Port}",
                        listener.Pid, port);
            }
        }

        _logger.LogInformation("port sweep done");
    }

    public async Task RecordAsync(int port, int pid, string command, ConnectionMode mode)
    {
        await _lock.WaitAsync().ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(OpenClawPaths.StateDirPath);
            _records.RemoveAll(r => r.Pid == pid);
            _records.Add(new PortGuardianRecord
            {
                Port      = port,
                Pid       = pid,
                Command   = command,
                Mode      = mode.ToString().ToLowerInvariant(),
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0,
            });
            Save();
        }
        finally { _lock.Release(); }
    }

    public void RemoveRecord(int pid)
    {
        _lock.Wait();
        try
        {
            var before = _records.Count;
            _records.RemoveAll(r => r.Pid == pid);
            if (_records.Count != before) Save();
        }
        finally { _lock.Release(); }
    }

    public async Task<PortGuardianDescriptor?> DescribeAsync(int port)
    {
        var listeners = await ListenersAsync(port).ConfigureAwait(false);
        if (listeners.Count == 0) return null;
        var first = listeners[0];
        var path  = GetExecutablePath(first.Pid);
        return new PortGuardianDescriptor(first.Pid, first.Command, path);
    }

    public async Task<List<PortReport>> DiagnoseAsync(ConnectionMode mode)
    {
        if (mode == ConnectionMode.Unconfigured) return [];

        var ports   = new[] { GatewayEnvironment.GatewayPort() };
        var reports = new List<PortReport>();
        foreach (var port in ports)
        {
            var listeners    = await ListenersAsync(port).ConfigureAwait(false);
            var tunnelHealth = await ProbeGatewayHealthIfNeededAsync(port, mode, listeners).ConfigureAwait(false);
            reports.Add(BuildReport(port, listeners, mode, tunnelHealth));
        }
        return reports;
    }

    public async Task<bool> ProbeGatewayHealthAsync(int port, TimeSpan timeout = default)
    {
        var url     = $"http://127.0.0.1:{port}/";
        var t       = timeout == default ? HealthProbeTimeout : timeout;
        using var handler = new HttpClientHandler { AllowAutoRedirect = false };
        using var client  = new HttpClient(handler) { Timeout = t };
        try
        {
            using var response = await client
                .GetAsync(url, HttpCompletionOption.ResponseHeadersRead)
                .ConfigureAwait(false);
            return true;
        }
        catch { return false; }
    }

    public async Task<bool> IsListeningAsync(int port, int? pid = null)
    {
        var listeners = await ListenersAsync(port).ConfigureAwait(false);
        if (pid.HasValue) return listeners.Any(l => l.Pid == pid.Value);
        return listeners.Count > 0;
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private sealed record Listener(int Pid, string Command, string FullCommand, string? User);

    private async Task<List<Listener>> ListenersAsync(int port)
    {
        // netstat -ano lists all TCP listeners with PIDs; we filter by port below.
        var output = await RunProcessAsync("netstat", ["-ano"], ListenersTimeoutMs).ConfigureAwait(false);
        if (output is null) return [];
        return ParseNetstatOutput(output, port);
    }

    // Exposed for testing
    private static List<Listener> ParseNetstatOutput(string text, int port)
    {
        // Windows netstat -ano format:
        //   Proto  Local Address          Foreign Address  State       PID
        //   TCP    0.0.0.0:18789          0.0.0.0:0        LISTENING   1234
        //   TCP    [::]:18789             [::]:0           LISTENING   1234
        var seen   = new HashSet<int>();
        var result = new List<Listener>();

        foreach (var line in text.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("TCP", StringComparison.OrdinalIgnoreCase)) continue;
            if (!trimmed.Contains("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;

            var parts = trimmed.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 5) continue;

            // Local address is parts[1]; PID is last column
            var localAddr = parts[1];
            var colon     = localAddr.LastIndexOf(':');
            if (colon < 0) continue;

            if (!int.TryParse(localAddr[(colon + 1)..], out var listenPort)
                || listenPort != port) continue;

            if (!int.TryParse(parts[^1], out var pid) || pid <= 0) continue;

            // Deduplicate by PID — IPv4 and IPv6 entries both appear for the same process
            if (!seen.Add(pid)) continue;

            var (command, fullCommand) = GetProcessInfo(pid);
            result.Add(new Listener(pid, command, fullCommand, null));
        }

        return result;
    }

    private static (string Command, string FullCommand) GetProcessInfo(int pid)
    {
        try
        {
            var proc = System.Diagnostics.Process.GetProcessById(pid);
            var name = proc.ProcessName;
            string full;
            try   { full = proc.MainModule?.FileName ?? name; }
            catch { full = name; }
            return (name, full);
        }
        catch { return ("unknown", "unknown"); }
    }

    private static string? GetExecutablePath(int pid)
    {
        try
        {
            var proc = System.Diagnostics.Process.GetProcessById(pid);
            try   { return proc.MainModule?.FileName; }
            catch { return null; }
        }
        catch { return null; }
    }

    private async Task<bool> KillAsync(int pid)
    {
        // CloseMainWindow() sends WM_CLOSE (graceful); Kill() forces termination.
        try
        {
            var proc   = System.Diagnostics.Process.GetProcessById(pid);
            var closed = proc.CloseMainWindow();
            if (closed)
            {
                var exited = await Task.Run(() => proc.WaitForExit(KillGracePeriodMs)).ConfigureAwait(false);
                if (exited) return true;
            }
            proc.Kill(entireProcessTree: false);
            return true;
        }
        catch { return false; }
    }

    private bool IsExpected(Listener listener, int port, ConnectionMode mode)
    {
        var cmd  = listener.Command.ToLowerInvariant();
        var full = listener.FullCommand.ToLowerInvariant();
        return mode switch
        {
            ConnectionMode.Remote =>
                port == GatewayEnvironment.GatewayPort() && cmd.Contains("ssh"),

            ConnectionMode.Local =>
                (full.Contains("openclaw") && full.Contains("gateway"))
                || (cmd.Contains("openclaw")
                    && string.Equals(full, cmd, StringComparison.OrdinalIgnoreCase)),

            _ => false,
        };
    }

    private async Task<bool?> ProbeGatewayHealthIfNeededAsync(
        int port, ConnectionMode mode, List<Listener> listeners)
    {
        if (mode != ConnectionMode.Remote
            || port != GatewayEnvironment.GatewayPort()
            || listeners.Count == 0)
            return null;

        var hasSsh = listeners.Any(l => l.Command.ToLowerInvariant().Contains("ssh"));
        if (!hasSsh) return null;

        return await ProbeGatewayHealthAsync(port).ConfigureAwait(false);
    }

    // Exposed for testing
    private static PortReport BuildReport(
        int port,
        List<Listener> listeners,
        ConnectionMode mode,
        bool? tunnelHealthy)
    {
        string expectedDesc;
        Func<Listener, bool> okPredicate;

        switch (mode)
        {
            case ConnectionMode.Remote:
                expectedDesc = "SSH tunnel to remote gateway";
                okPredicate  = l => l.Command.ToLowerInvariant().Contains("ssh");
                break;
            case ConnectionMode.Local:
                expectedDesc = "Gateway websocket (node/tsx)";
                okPredicate  = l =>
                {
                    var c = l.Command.ToLowerInvariant();
                    return ExpectedLocalCommands.Any(e => c.Contains(e));
                };
                break;
            default:
                expectedDesc = "Gateway not configured";
                okPredicate  = _ => false;
                break;
        }

        if (listeners.Count == 0)
        {
            var missingText = $"Nothing is listening on {port} ({expectedDesc}).";
            return new PortReport
            {
                Port      = port,
                Expected  = expectedDesc,
                Status    = new PortReportStatus.Missing(missingText),
                Listeners = [],
            };
        }

        var tunnelUnhealthy =
            mode == ConnectionMode.Remote
            && port == GatewayEnvironment.GatewayPort()
            && tunnelHealthy == false;

        var reportListeners = listeners.Select(l =>
        {
            var expected = okPredicate(l);
            if (tunnelUnhealthy && expected) expected = false;
            return new PortReportListener
            {
                Pid         = l.Pid,
                Command     = l.Command,
                FullCommand = l.FullCommand,
                User        = l.User,
                Expected    = expected,
            };
        }).ToList();

        var offenders = reportListeners.Where(l => !l.Expected).ToList();

        if (tunnelUnhealthy)
        {
            var list   = string.Join(", ", listeners.Select(l => $"{l.Command} ({l.Pid})"));
            var reason = $"Port {port} is served by {list}, but the SSH tunnel is unhealthy.";
            return new PortReport
            {
                Port      = port,
                Expected  = expectedDesc,
                Status    = new PortReportStatus.Interference(reason, offenders),
                Listeners = reportListeners,
            };
        }

        if (offenders.Count == 0)
        {
            var list   = string.Join(", ", listeners.Select(l => $"{l.Command} ({l.Pid})"));
            var okText = $"Port {port} is served by {list}.";
            return new PortReport
            {
                Port      = port,
                Expected  = expectedDesc,
                Status    = new PortReportStatus.Ok(okText),
                Listeners = reportListeners,
            };
        }

        var interferenceList   = string.Join(", ", offenders.Select(l => $"{l.Command} ({l.Pid})"));
        var interferenceReason = $"Port {port} is held by {interferenceList}, expected {expectedDesc}.";
        return new PortReport
        {
            Port      = port,
            Expected  = expectedDesc,
            Status    = new PortReportStatus.Interference(interferenceReason, offenders),
            Listeners = reportListeners,
        };
    }

    private static List<PortGuardianRecord> LoadRecords(string path)
    {
        try
        {
            if (!File.Exists(path)) return [];
            var data = File.ReadAllBytes(path);
            return JsonSerializer.Deserialize<List<PortGuardianRecord>>(data) ?? [];
        }
        catch { return []; }
    }

    private void Save()
    {
        // Called under _lock — temp-file swap for atomic write.
        try
        {
            var data = JsonSerializer.SerializeToUtf8Bytes(_records);
            var tmp  = RecordPath + ".tmp";
            File.WriteAllBytes(tmp, data);
            File.Move(tmp, RecordPath, overwrite: true);
        }
        catch { }
    }

    private static async Task<string?> RunProcessAsync(string exe, string[] args, int timeoutMs)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName               = exe,
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var proc = new Process { StartInfo = psi };
            proc.Start();

            using var cts = new CancellationTokenSource(timeoutMs);
            try
            {
                var outTask = proc.StandardOutput.ReadToEndAsync(cts.Token);
                await proc.WaitForExitAsync(cts.Token).ConfigureAwait(false);
                return await outTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                try { proc.Kill(); } catch { }
                return null;
            }
        }
        catch { return null; }
    }

    // ── Test helpers ──────────────────────────────────────────────────────────

    internal static List<(int Pid, string Command, string FullCommand, string? User)>
        TestParseListeners(string text, int port) =>
        ParseNetstatOutput(text, port)
            .Select(l => (l.Pid, l.Command, l.FullCommand, l.User))
            .ToList();

    internal static PortReport TestBuildReport(
        int port,
        ConnectionMode mode,
        List<(int Pid, string Command, string FullCommand, string? User)> listeners) =>
        BuildReport(
            port,
            listeners.Select(l => new Listener(l.Pid, l.Command, l.FullCommand, l.User)).ToList(),
            mode,
            null);
}
