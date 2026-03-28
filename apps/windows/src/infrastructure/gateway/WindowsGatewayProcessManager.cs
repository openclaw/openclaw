using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using MediatR;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Manages the lifecycle of the local OpenClaw gateway process.
/// Uses Process.Start for immediate spawn and monitors Exited for KeepAlive restart.
/// </summary>
internal sealed class WindowsGatewayProcessManager : IGatewayProcessManager, IHostedService
{
    // Tunables
    private const int DefaultGatewayPort     = 18789;
    private const int LogLimitChars          = 20_000;
    private const int HealthProbeTimeoutMs   = 2_000;
    private const int StartupPollIntervalMs  = 400;
    private const int StartupTimeoutSeconds  = 6;
    private const int AttachProbeTimeoutMs   = 500;
    private const int AttachRetryIntervalMs  = 250;
    private const int AttachMaxAttempts      = 3;
    private const int RestartDelayMs         = 1_000;   // KeepAlive equivalent after unexpected exit

    private readonly ISettingsRepository _settings;
    private readonly GatewayConnection _connection;
    private readonly ILogger<WindowsGatewayProcessManager> _logger;

    private readonly object _lock = new();
    private GatewayProcessStatus _status = GatewayProcessStatus.Stopped();
    private string _log = string.Empty;
    private volatile bool _desiredActive;
    private Process? _gatewayProcess;

    public GatewayProcessStatus Status { get { lock (_lock) return _status; } }
    public string Log { get { lock (_lock) return _log; } }

    public WindowsGatewayProcessManager(
        ISettingsRepository settings,
        GatewayConnection connection,
        ILogger<WindowsGatewayProcessManager> logger)
    {
        _settings   = settings;
        _connection = connection;
        _logger     = logger;
    }

    // ─── IHostedService ────────────────────────────────────────────────────────

    public Task StartAsync(CancellationToken ct)
    {
        // SetActive(true) after other hosted services have had a chance to start.
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(500, ct).ConfigureAwait(false);
                SetActive(true);
            }
            catch (OperationCanceledException) { }
        }, CancellationToken.None);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken _ct)
    {
        _desiredActive = false;
        KillGatewayProcess();
        return Task.CompletedTask;
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    public void SetActive(bool active)
    {
        // Capture intent synchronously before the async settings check.
        _desiredActive = active;

        _ = Task.Run(async () =>
        {
            try
            {
                var settings = await _settings.LoadAsync(CancellationToken.None).ConfigureAwait(false);

                // Remote mode: the gateway runs on the remote host — never spawn locally.
                if (settings.ConnectionMode == ConnectionMode.Remote)
                {
                    _desiredActive = false;
                    SetStatus(GatewayProcessStatus.Stopped());
                    AppendLog("[gateway] remote mode active; skipping local gateway\n");
                    _logger.LogInformation("Gateway process skipped: remote mode active");
                    return;
                }

                if (active)
                    StartIfNeeded();
                else
                    StopInternal();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SetActive({Active}) failed", active);
            }
        });
    }

    public void RefreshLog()
    {
        var logPath = GatewayLogPath();
        _ = Task.Run(() =>
        {
            try
            {
                if (!File.Exists(logPath)) return;
                var text = ReadTail(logPath, LogLimitChars);
                lock (_lock) { _log = text; }
            }
            catch (Exception ex) { _logger.LogDebug(ex, "Failed to read gateway log"); }
        });
    }

    public async Task<bool> WaitForGatewayReadyAsync(TimeSpan timeout, CancellationToken ct)
    {
        var port     = GatewayPort();
        var deadline = DateTime.UtcNow.Add(timeout);

        while (DateTime.UtcNow < deadline)
        {
            if (!_desiredActive) return false;
            ct.ThrowIfCancellationRequested();

            if (await CanConnectToPortAsync(port, HealthProbeTimeoutMs).ConfigureAwait(false))
                return true;

            try { await Task.Delay(300, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return false; }
        }

        AppendLog("[gateway] readiness wait timed out\n");
        _logger.LogWarning("Gateway readiness wait timed out");
        return false;
    }

    // ─── Lifecycle internals ───────────────────────────────────────────────────

    private void StartIfNeeded()
    {
        lock (_lock)
        {
            var kind = _status.Kind;
            // Many callers may invoke StartIfNeeded() concurrently (startup, canvas checks, etc.).
            // Avoid spawning multiple start tasks by guarding on in-progress states.
            if (kind is GatewayProcessStatusKind.Starting
                     or GatewayProcessStatusKind.Running
                     or GatewayProcessStatusKind.AttachedExisting)
                return;

            _status = GatewayProcessStatus.Starting();
        }

        _logger.LogDebug("Gateway start requested");

        _ = Task.Run(async () =>
        {
            try
            {
                if (await AttachExistingGatewayIfAvailableAsync().ConfigureAwait(false)) return;
                await SpawnGatewayAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                SetStatus(GatewayProcessStatus.Failed(ex.Message));
                _logger.LogError(ex, "Gateway start failed unexpectedly");
            }
        });
    }

    private void StopInternal()
    {
        _desiredActive = false;
        SetStatus(GatewayProcessStatus.Stopped());
        KillGatewayProcess();
        _logger.LogInformation("Gateway stop requested");
    }

    // ─── Attach existing ───────────────────────────────────────────────────────

    // if something is already listening on the gateway port, latch onto it instead of spawning.
    private async Task<bool> AttachExistingGatewayIfAvailableAsync()
    {
        var port = GatewayPort();

        // Quick initial probe to decide how many attempts are worth retrying.
        var hasListener = await CanConnectToPortAsync(port, AttachProbeTimeoutMs).ConfigureAwait(false);

        var maxAttempts = hasListener ? AttachMaxAttempts : 1;
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            if (await CanConnectToPortAsync(port, HealthProbeTimeoutMs).ConfigureAwait(false))
            {
                var details = await GetPortDetailsAsync(port).ConfigureAwait(false) ?? $"port {port}";
                SetStatus(GatewayProcessStatus.AttachedExisting(details));
                AppendLog($"[gateway] using existing instance: {details}\n");
                _logger.LogInformation("Gateway attach succeeded details={Details}", details);
                RefreshLog();
                LogControlChannelState("attach existing");

                // Local gateway detected — ensure ConnectionMode is set so the
                // reconnect coordinator can resolve the endpoint and connect.
                await AutoResolveConnectionModeAsync(port).ConfigureAwait(false);

                // Monitor the attached gateway: if it exits, reset state and respawn.
                // behaviour even when we attached rather than started the process.
                _ = MonitorAttachedGatewayAsync(port);
                return true;
            }

            if (attempt < maxAttempts - 1)
                await Task.Delay(AttachRetryIntervalMs).ConfigureAwait(false);
        }

        if (hasListener)
        {
            // Something occupies the port but won't accept our probe — likely a non-gateway process.
            var reason = $"Port {port} is occupied but did not respond; check for port conflicts";
            SetStatus(GatewayProcessStatus.Failed(reason));
            AppendLog($"[gateway] existing listener on port {port} but attach failed: {reason}\n");
            _logger.LogWarning("Gateway attach failed reason={Reason}", reason);
            // Return true to prevent spawning a duplicate that would also fail on the occupied port.
            return true;
        }

        // No listener found — caller should spawn a new gateway process.
        return false;
    }

    // Polls port every 3s while attached; triggers respawn if the gateway process exits.
    private async Task MonitorAttachedGatewayAsync(int port)
    {
        while (_desiredActive)
        {
            await Task.Delay(3_000).ConfigureAwait(false);
            if (!_desiredActive) return;

            // Stop monitoring if the process manager has moved on (e.g., spawned a new process).
            if (Status.Kind != GatewayProcessStatusKind.AttachedExisting) return;

            if (await CanConnectToPortAsync(port, HealthProbeTimeoutMs).ConfigureAwait(false)) continue;

            _logger.LogWarning("Attached gateway on port {Port} is no longer responding — restarting", port);
            AppendLog("[gateway] attached instance exited — restarting\n");

            // Reset to Stopped so StartIfNeeded() does not short-circuit.
            lock (_lock) { _status = GatewayProcessStatus.Stopped(); }

            if (_desiredActive) StartIfNeeded();
            return;
        }
    }

    // ─── Spawn ─────────────────────────────────────────────────────────────────

    // resolve the gateway command, start the process, poll health for up to StartupTimeoutSeconds.
    private async Task SpawnGatewayAsync()
    {
        var port    = GatewayPort();
        var command = ResolveGatewayCommand(port);
        if (command is null)
        {
            var reason = "openclaw CLI not found in PATH; install via: npm install -g openclaw";
            SetStatus(GatewayProcessStatus.Failed(reason));
            AppendLog($"[gateway] command resolve failed: {reason}\n");
            _logger.LogError("Gateway command resolve failed — openclaw not found");
            return;
        }

        AppendLog($"[gateway] spawning: {string.Join(" ", command)}\n");
        _logger.LogInformation("Gateway spawning command={Command}", string.Join(" ", command));

        try
        {
            KillGatewayProcess();

            var psi = new ProcessStartInfo
            {
                FileName               = command[0],
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true,
            };
            for (var i = 1; i < command.Length; i++)
                psi.ArgumentList.Add(command[i]);

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (_, e) => { if (e.Data is not null) AppendLog(e.Data + "\n"); };
            proc.ErrorDataReceived  += (_, e) => { if (e.Data is not null) AppendLog(e.Data + "\n"); };
            proc.Exited             += OnGatewayExited;

            // Store reference before Start() so a very-fast exit in OnGatewayExited sees null cleanly.
            lock (_lock) { _gatewayProcess = proc; }

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            lock (_lock) { _gatewayProcess = null; }
            SetStatus(GatewayProcessStatus.Failed(ex.Message));
            AppendLog($"[gateway] spawn failed: {ex.Message}\n");
            _logger.LogError(ex, "Gateway spawn failed");
            return;
        }

        // Poll health until the gateway accepts connections.
        var deadline = DateTime.UtcNow.AddSeconds(StartupTimeoutSeconds);
        while (DateTime.UtcNow < deadline)
        {
            if (!_desiredActive) return;

            if (await CanConnectToPortAsync(port, HealthProbeTimeoutMs).ConfigureAwait(false))
            {
                int? pid = null;
                lock (_lock) { try { pid = _gatewayProcess?.Id; } catch { } }
                var details = pid.HasValue ? $"pid {pid}" : null;
                SetStatus(GatewayProcessStatus.Running(details));
                AppendLog($"[gateway] started: {details ?? "ok"}\n");
                _logger.LogInformation("Gateway started details={Details}", details);
                LogControlChannelState("gateway started");
                RefreshLog();

                // Local gateway spawned — ensure ConnectionMode is set so the
                // reconnect coordinator can resolve the endpoint and connect.
                await AutoResolveConnectionModeAsync(port).ConfigureAwait(false);
                return;
            }

            await Task.Delay(StartupPollIntervalMs).ConfigureAwait(false);
        }

        SetStatus(GatewayProcessStatus.Failed("Gateway did not start in time"));
        AppendLog("[gateway] start timed out\n");
        _logger.LogWarning("Gateway start timed out");
    }

    // ─── Process lifecycle ─────────────────────────────────────────────────────

    private void OnGatewayExited(object? sender, EventArgs e)
    {
        int? pid = null;
        try { pid = (sender as Process)?.Id; } catch { }

        AppendLog($"[gateway] process exited pid={pid}\n");
        _logger.LogWarning("Gateway process exited pid={Pid}", pid);

        lock (_lock) { _gatewayProcess = null; }

        if (!_desiredActive) return;

        // Gateway died unexpectedly — restart after a brief delay.
        // Reset to Stopped (not Starting) so StartIfNeeded() does not short-circuit
        // on the Starting guard at the top of that method.
        SetStatus(GatewayProcessStatus.Stopped());
        _ = Task.Run(async () =>
        {
            await Task.Delay(RestartDelayMs).ConfigureAwait(false);
            if (_desiredActive) StartIfNeeded();
        });
    }

    private void KillGatewayProcess()
    {
        Process? proc;
        lock (_lock)
        {
            proc = _gatewayProcess;
            _gatewayProcess = null;
        }

        if (proc is null) return;

        try
        {
            proc.Exited -= OnGatewayExited;
            if (!proc.HasExited)
                proc.Kill(entireProcessTree: true);
            proc.Dispose();
        }
        catch (Exception ex) { _logger.LogDebug(ex, "KillGatewayProcess non-fatal"); }
    }

    // ─── Auto-resolve ───────────────────────────────────────────────────────────

    // When a local gateway is detected (attach or spawn), auto-resolve
    // ConnectionMode to Local and set a default GatewayEndpointUri so that the
    // reconnect coordinator can resolve an endpoint and trigger the WebSocket
    // connect → hello-ok handshake.  Without this, first-time users who skip
    // onboarding are stuck in Unconfigured mode with no connection.
    private async Task AutoResolveConnectionModeAsync(int port)
    {
        try
        {
            var s = await _settings.LoadAsync(CancellationToken.None).ConfigureAwait(false);

            var changed = false;
            if (s.ConnectionMode == ConnectionMode.Unconfigured)
            {
                s.SetConnectionMode(ConnectionMode.Local);
                s.SetOnboardingSeen(true);
                changed = true;
                _logger.LogInformation("Auto-resolved ConnectionMode to Local after gateway detected");
            }

            if (string.IsNullOrWhiteSpace(s.GatewayEndpointUri))
            {
                s.SetGatewayEndpointUri($"ws://localhost:{port}");
                changed = true;
                _logger.LogInformation("Auto-set GatewayEndpointUri to ws://localhost:{Port}", port);
            }

            if (changed)
                await _settings.SaveAsync(s, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to auto-resolve connection mode");
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    private void SetStatus(GatewayProcessStatus status) { lock (_lock) { _status = status; } }

    private void AppendLog(string chunk)
    {
        lock (_lock)
        {
            _log += chunk;
            // Ring buffer — keep the most recent LogLimitChars characters.
            if (_log.Length > LogLimitChars)
                _log = _log[(_log.Length - LogLimitChars)..];
        }
    }

    // Logs the current control channel state after the gateway becomes available.
    // the reconnect coordinator
    // picks up Disconnected state within its 1-second poll cycle without explicit prodding.
    private void LogControlChannelState(string reason)
    {
        var state = _connection.State;
        AppendLog($"[gateway] ready ({reason}), control channel state={state}\n");
        _logger.LogDebug("Gateway ready reason={Reason} connectionState={State}", reason, state);
    }

    // ─── Gateway resolution ────────────────────────────────────────────────────

    // env var overrides default.
    private static int GatewayPort()
    {
        var env = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_PORT");
        if (!string.IsNullOrWhiteSpace(env) && int.TryParse(env.Trim(), out var p) && p > 0)
            return p;
        return DefaultGatewayPort;
    }

    // returns command + args array or null.
    private static string[]? ResolveGatewayCommand(int port)
    {
        var exe = FindOpenClawExecutable();
        if (exe is null) return null;
        return [exe, "gateway", "--port", $"{port}", "--bind", "loopback", "--allow-unconfigured"];
    }

    // find openclaw CLI on Windows.
    private static string? FindOpenClawExecutable()
    {
        // 1. Common npm global install locations on Windows.
        var appData      = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates =
        [
            Path.Combine(appData,      "npm",     "openclaw.cmd"),
            Path.Combine(localAppData, "npm",     "openclaw.cmd"),
        ];
        foreach (var c in candidates)
            if (File.Exists(c)) return c;

        // 2. Fall back to PATH lookup via where.exe (handles nvm-windows, volta, etc.)
        return FindInPath("openclaw") ?? FindInPath("openclaw.cmd");
    }

    private static string? FindInPath(string name)
    {
        try
        {
            var psi = new ProcessStartInfo("where.exe")
            {
                RedirectStandardOutput = true,
                UseShellExecute        = false,
                CreateNoWindow         = true,
            };
            psi.ArgumentList.Add(name);

            using var p = Process.Start(psi);
            if (p is null) return null;

            var output = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit();

            var first = output
                .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault()
                ?.Trim();
            return string.IsNullOrEmpty(first) ? null : first;
        }
        catch { return null; }
    }

    // ─── Network probes ────────────────────────────────────────────────────────

    private static async Task<bool> CanConnectToPortAsync(int port, int timeoutMs)
    {
        try
        {
            using var tcp = new TcpClient();
            using var cts = new CancellationTokenSource(timeoutMs);
            await tcp.ConnectAsync(IPAddress.Loopback, port, cts.Token).ConfigureAwait(false);
            return true;
        }
        catch { return false; }
    }

    // get PID listening on the given port.
    private static async Task<string?> GetPortDetailsAsync(int port)
    {
        try
        {
            var psi = new ProcessStartInfo("netstat.exe")
            {
                RedirectStandardOutput = true,
                UseShellExecute        = false,
                CreateNoWindow         = true,
            };
            psi.ArgumentList.Add("-ano");
            psi.ArgumentList.Add("-p");
            psi.ArgumentList.Add("TCP");

            using var p = Process.Start(psi);
            if (p is null) return null;

            var output = await p.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
            await p.WaitForExitAsync().ConfigureAwait(false);

            // Parse: TCP  127.0.0.1:18789  0.0.0.0:0  LISTENING  <pid>
            var portSuffix = $":{port}";
            foreach (var line in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = line.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 5
                    && parts[0].Equals("TCP",       StringComparison.OrdinalIgnoreCase)
                    && parts[1].EndsWith(portSuffix, StringComparison.Ordinal)
                    && parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase))
                    return $"pid {parts[4]}, port {port}";
            }
        }
        catch { }

        return null;
    }

    // ─── Log file ──────────────────────────────────────────────────────────────

    private static string GatewayLogPath()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(appData, "OpenClaw", "logs", "gateway.log");
    }

    // Read the last `limit` characters from a file without loading it fully into memory.
    private static string ReadTail(string path, int limit)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (fs.Length <= limit)
        {
            using var r = new StreamReader(fs);
            return r.ReadToEnd();
        }
        fs.Seek(-limit, SeekOrigin.End);
        using var tailReader = new StreamReader(fs);
        return tailReader.ReadToEnd();
    }
}
