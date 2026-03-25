using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// SSH port-forward tunnel for remote mode.
/// ssh -N -L to forward the remote gateway port to localhost.
/// </summary>
internal sealed class SshRemoteTunnelService : IRemoteTunnelService, IDisposable
{
    // Tunables
    private const int StartupProbeDelayMs = 150;      // wait after ssh spawn before checking HasExited
    private const int ServerAliveInterval  = 15;       // -o ServerAliveInterval=15
    private const int ServerAliveCountMax  = 3;        // -o ServerAliveCountMax=3
    private const int DefaultRemotePort    = 18789;    // gateway port forwarded on the remote host

    private readonly ILogger<SshRemoteTunnelService> _logger;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private Process? _sshProcess;
    private bool _isConnected;
    private int _lastKnownPid; // PID of the last SSH tunnel we started or recognized

    // IsConnected reflects live process state — if our process exited unexpectedly, the
    // property returns false immediately so the reconnect coordinator can restart the tunnel.
    public bool IsConnected =>
        _isConnected && (_sshProcess == null || !_sshProcess.HasExited);

    public SshRemoteTunnelService(ILogger<SshRemoteTunnelService> logger)
    {
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> ConnectAsync(string tunnelEndpoint, int localPort, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            // Terminate any existing tunnel before starting a new one.
            TerminateExisting();

            var (destination, identityFile) = ParseTunnelEndpoint(tunnelEndpoint);
            var (_, sshPort) = ParseSshTarget(destination);

            // If a previous OpenClaw run left an SSH listener on the expected port, reuse it.
            // _lastKnownPid > 0 restricts reuse to the exact process we last started,
            // preventing accidentally inheriting an unrelated SSH forward (OQ-004).
            if (IsPortListeningBySshProcess(localPort, _lastKnownPid))
            {
                _logger.LogInformation("Reusing existing SSH listener on port {Port}", localPort);
                _isConnected = true;
                return Result.Success;
            }

            // If the port is taken by something other than SSH, fail fast.
            if (IsPortOccupied(localPort))
                return Error.Failure("SSH.PORT_BUSY",
                    $"Local port {localPort} is already in use by a non-SSH process.");

            var sshExe = FindSshExecutable();
            if (sshExe is null)
                return Error.Failure("SSH.NOT_FOUND",
                    "ssh.exe not found. Enable the Windows OpenSSH client optional feature.");

            var args = BuildArguments(destination, localPort, DefaultRemotePort, identityFile, sshPort);

            _logger.LogInformation("Starting SSH tunnel: {Exe} {Args}",
                sshExe, string.Join(" ", args));

            var startInfo = new ProcessStartInfo
            {
                FileName          = sshExe,
                UseShellExecute   = false,
                CreateNoWindow    = true,
                RedirectStandardError = true,
            };
            foreach (var a in args) startInfo.ArgumentList.Add(a);

            var process = new Process { StartInfo = startInfo };

            // Consume stderr asynchronously so ssh never blocks on a full pipe.
            process.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                    _logger.LogError("ssh stderr: {Line}", e.Data);
            };

            process.Start();
            process.BeginErrorReadLine();

            // Wait 150 ms then check if the process is still alive.
            await Task.Delay(StartupProbeDelayMs, ct);

            if (process.HasExited)
            {
                _logger.LogError("SSH tunnel exited immediately (code {Code})", process.ExitCode);
                process.Dispose();
                return Error.Failure("SSH.EXITED",
                    $"ssh exited immediately (code {process.ExitCode}). " +
                    "Check the remote target, identity file, and host-key trust.");
            }

            _sshProcess   = process;
            _lastKnownPid = process.Id;
            _isConnected  = true;

            _logger.LogInformation("SSH tunnel ready: {Dest} → 127.0.0.1:{LocalPort}",
                destination, localPort);

            return Result.Success;
        }
        catch (OperationCanceledException)
        {
            return Error.Failure("SSH.CANCELLED", "Connect canceled.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SSH tunnel connect failed");
            return Error.Failure("SSH.ERROR", ex.Message);
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task DisconnectAsync(CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            TerminateExisting();
        }
        finally
        {
            _lock.Release();
        }
    }

    // ─── Process management ────────────────────────────────────────────────────

    private void TerminateExisting()
    {
        var proc     = _sshProcess;
        _sshProcess  = null;
        _isConnected = false;
        if (proc is null) return;

        try
        {
            if (!proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
                proc.WaitForExit(2000);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error killing SSH process");
        }
        finally
        {
            proc.Dispose();
        }
    }

    // ─── Port detection ────────────────────────────────────────────────────────

    // Returns true if the port has a TCP listener owned by an SSH process.
    // When expectedPid > 0 the listener must belong to that exact PID — prevents
    // silently inheriting an unrelated SSH forward (OQ-004 guard).
    // When expectedPid == 0 (first cold start, no known PID) any ssh process is accepted,
    // preserving the crash-recovery reuse behavior.
    private static bool IsPortListeningBySshProcess(int port, int expectedPid)
    {
        if (!IsPortOccupied(port)) return false;

        try
        {
            // Resolve the PID listening on the port via netstat -ano
            using var proc = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName               = "netstat.exe",
                    Arguments              = "-ano -p TCP",
                    UseShellExecute        = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow         = true,
                }
            };
            proc.Start();
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(3000);

            var portToken = $":{port}";
            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                if (!line.Contains("LISTENING") && !line.Contains("LISTE")) continue;
                if (!line.Contains(portToken)) continue;

                var cols = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (cols.Length == 0 || !int.TryParse(cols[^1], out var pid)) continue;

                // OQ-004: if we know which PID we last started, reject any other.
                if (expectedPid > 0 && pid != expectedPid) return false;

                try
                {
                    var owner = Process.GetProcessById(pid);
                    return owner.ProcessName.Contains("ssh", StringComparison.OrdinalIgnoreCase);
                }
                catch { /* PID gone */ }
            }
        }
        catch { }

        return false;
    }

    // Returns true if any listener is bound to the local port (regardless of process).
    private static bool IsPortOccupied(int port)
    {
        try
        {
            var listeners = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners();
            return listeners.Any(ep => ep.Port == port);
        }
        catch
        {
            // Fall back to bind probe
            try
            {
                using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                socket.Bind(new IPEndPoint(IPAddress.Loopback, port));
                return false; // bind succeeded → port is free
            }
            catch (SocketException)
            {
                return true; // bind failed → port is occupied
            }
        }
    }

    // ─── SSH discovery ─────────────────────────────────────────────────────────

    // Finds ssh.exe in standard Windows locations.
    // Priority: System32\OpenSSH (built-in Win10+) → PATH.
    private static string? FindSshExecutable()
    {
        var builtIn = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "OpenSSH", "ssh.exe");
        if (File.Exists(builtIn)) return builtIn;

        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "")
                     .Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), "ssh.exe");
            if (File.Exists(candidate)) return candidate;
        }

        return null;
    }

    // ─── Argument construction ─────────────────────────────────────────────────

    private static IReadOnlyList<string> BuildArguments(
        string destination, int localPort, int remotePort, string? identityFile, int? sshPort)
    {
        var args = new List<string>
        {
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UpdateHostKeys=yes",
            "-o", $"ServerAliveInterval={ServerAliveInterval}",
            "-o", $"ServerAliveCountMax={ServerAliveCountMax}",
            "-o", "TCPKeepAlive=yes",
            "-N",
            // Explicit loopback bind address for security — Windows ssh supports the full
            // [bind_address:]port:host:hostport syntax.
            "-L", $"127.0.0.1:{localPort}:127.0.0.1:{remotePort}",
        };

        // SSH port override (e.g. when the remote SSH daemon is on a non-standard port)
        if (sshPort.HasValue && sshPort.Value != 22)
        {
            args.Add("-p");
            args.Add(sshPort.Value.ToString());
        }

        if (!string.IsNullOrWhiteSpace(identityFile))
        {
            args.Add("-i");
            args.Add(identityFile);
        }

        // Destination is always last
        args.Add(destination);
        return args;
    }

    // ─── Endpoint parsing ──────────────────────────────────────────────────────

    // Detects the format produced by ApplyConnectionModeHandler:
    //   - Normal:   "user@host" or "host"
    //   - With key: "/path/to/key@user@host" (identity path prepended with @)
    private static (string destination, string? identityFile) ParseTunnelEndpoint(string endpoint)
    {
        var first = endpoint.IndexOf('@');
        if (first < 0) return (endpoint, null);

        var prefix = endpoint[..first];
        // A path prefix contains directory separators — treat it as an identity file.
        if (prefix.Contains('/') || prefix.Contains('\\') || Path.IsPathRooted(prefix))
            return (endpoint[(first + 1)..], prefix);

        return (endpoint, null);
    }

    // Splits "user@host:port" → ("user@host", port) where port is the SSH daemon port.
    private static (string target, int? sshPort) ParseSshTarget(string destination)
    {
        // Isolate the host part after the last '@'
        var atIdx   = destination.LastIndexOf('@');
        var hostPart = atIdx >= 0 ? destination[(atIdx + 1)..] : destination;

        // Look for a trailing port (host:port) in the host segment only
        var colon = hostPart.LastIndexOf(':');
        if (colon >= 0 && int.TryParse(hostPart[(colon + 1)..], out var port))
        {
            // Strip the port from the full destination string
            var stripped = destination[..(destination.Length - hostPart.Length + colon)];
            return (stripped, port);
        }

        return (destination, null);
    }

    // ─── Cleanup ───────────────────────────────────────────────────────────────

    public void Dispose()
    {
        TerminateExisting();
        _lock.Dispose();
    }
}
