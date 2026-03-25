using System.Reflection;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Os;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Paths;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Periodic presence broadcast to the control channel.
/// on start ("launch") and every 3 minutes ("periodic").
/// </summary>
internal sealed class PresenceReporter : IHostedService
{
    // Tunables
    private const int IntervalSeconds = 180;

    private readonly IGatewayRpcChannel             _rpc;
    private readonly ISettingsRepository            _settings;
    private readonly ILogger<PresenceReporter>      _logger;

    private readonly string _instanceId = GetOrCreateInstanceId();

    private CancellationTokenSource? _cts;
    private Task?                    _loopTask;

    public PresenceReporter(
        IGatewayRpcChannel        rpc,
        ISettingsRepository       settings,
        ILogger<PresenceReporter> logger)
    {
        _rpc      = rpc;
        _settings = settings;
        _logger   = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _cts      = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _loopTask = Task.Run(() => RunLoopAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _cts?.Cancel();
        if (_loopTask is not null)
        {
            try { await _loopTask.WaitAsync(ct); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _logger.LogWarning(ex, "Presence reporter loop did not stop cleanly"); }
        }
    }

    internal void SendImmediate(string reason = "connect") =>
        _ = Task.Run(() => PushAsync(reason, CancellationToken.None));

    private async Task RunLoopAsync(CancellationToken ct)
    {
        await PushAsync("launch", ct);
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(IntervalSeconds), ct); }
            catch (OperationCanceledException) { return; }
            await PushAsync("periodic", ct);
        }
    }

    internal async Task PushAsync(string reason, CancellationToken ct)
    {
        ConnectionMode mode;
        try
        {
            var appSettings = await _settings.LoadAsync(ct);
            mode = appSettings.ConnectionMode;
        }
        catch { mode = ConnectionMode.Local; }

        var modeStr  = mode.ToString().ToLower();
        var host     = Environment.MachineName;
        var ip       = SystemPresenceInfo.PrimaryIPv4Address() ?? "ip-unknown";
        var version  = AppVersionString();
        var platform = PlatformString();
        var lastInput = SystemPresenceInfo.LastInputSeconds();
        var text     = ComposePresenceSummary(modeStr, reason);

        var parameters = new Dictionary<string, object?>
        {
            ["instanceId"]   = _instanceId,
            ["host"]         = host,
            ["ip"]           = ip,
            ["mode"]         = modeStr,
            ["version"]      = version,
            ["platform"]     = platform,
            ["deviceFamily"] = "PC",
            ["reason"]       = reason,
            ["text"]         = text,
        };

        if (lastInput.HasValue)
            parameters["lastInputSeconds"] = lastInput.Value;

        // modelIdentifier: no Windows equivalent of hw.model without WMI — omitted

        try { await _rpc.SendSystemEventAsync(parameters, ct); }
        catch (Exception ex) { _logger.LogError(ex, "presence send failed"); }
    }

    internal static string ComposePresenceSummary(string mode, string reason)
    {
        var host      = Environment.MachineName;
        var ip        = SystemPresenceInfo.PrimaryIPv4Address() ?? "ip-unknown";
        var version   = AppVersionString();
        var lastInput = SystemPresenceInfo.LastInputSeconds();
        var lastLabel = lastInput.HasValue ? $"last input {lastInput.Value}s ago" : "last input unknown";
        return $"Node: {host} ({ip}) Â· app {version} Â· {lastLabel} Â· mode {mode} Â· reason {reason}";
    }

    internal static string AppVersionString()
    {
        var ver = Assembly.GetEntryAssembly()?.GetName().Version;
        if (ver is null) return "dev";
        var core = $"{ver.Major}.{ver.Minor}.{ver.Build}";
        // Append revision if non-zero.
        return ver.Revision > 0 ? $"{core} ({ver.Revision})" : core;
    }

    internal static string PlatformString()
    {
        var v = Environment.OSVersion.Version;
        return $"windows {v.Major}.{v.Minor}.{v.Build}";
    }

    // persisted UUID in state dir
    private static string GetOrCreateInstanceId()
    {
        try
        {
            var path = Path.Combine(OpenClawPaths.StateDirPath, "instance-id");
            if (File.Exists(path))
            {
                var existing = File.ReadAllText(path).Trim();
                if (!string.IsNullOrEmpty(existing)) return existing;
            }
            var id = Guid.NewGuid().ToString("D").ToLowerInvariant();
            Directory.CreateDirectory(OpenClawPaths.StateDirPath);
            File.WriteAllText(path, id);
            return id;
        }
        catch
        {
            return Guid.NewGuid().ToString("D").ToLowerInvariant();
        }
    }
}
