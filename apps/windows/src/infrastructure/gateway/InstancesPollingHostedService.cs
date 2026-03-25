using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Instances;
using OpenClawWindows.Domain.Notifications;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Polls system-presence every 30 s and subscribes to "presence" push events.
/// </summary>
internal sealed class InstancesPollingHostedService : IHostedService, IDisposable
{
    // Tunables
    private const int PollIntervalMs    = 30_000;
    private const int RpcTimeoutMs      = 15_000;   // outer request timeout
    private const int BackoffOnErrorMs  =  5_000;

    private readonly IGatewayRpcChannel        _rpc;
    private readonly IInstancesStore           _store;
    private readonly GatewayConnection         _connection;
    private readonly GatewayRpcChannelAdapter  _adapter;
    private readonly INotificationProvider     _notifications;
    private readonly ILogger<InstancesPollingHostedService> _logger;

    private CancellationTokenSource? _cts;
    private Task? _loopTask;

    // Dedup node-connected notifications
    private readonly Dictionary<string, double> _lastLoginNotifiedAtMs = [];
    private readonly Dictionary<string, InstanceInfo> _lastPresenceById = [];
    private readonly Lock _notifyLock = new();

    public InstancesPollingHostedService(
        IGatewayRpcChannel rpc,
        IInstancesStore store,
        GatewayConnection connection,
        GatewayRpcChannelAdapter adapter,
        INotificationProvider notifications,
        ILogger<InstancesPollingHostedService> logger)
    {
        _rpc           = rpc;
        _store         = store;
        _connection    = connection;
        _adapter       = adapter;
        _notifications = notifications;
        _logger        = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _adapter.PresenceReceived += OnPresenceEvent;
        _adapter.GatewaySnapshot  += OnSnapshot;
        _adapter.GatewaySeqGap    += OnSeqGap;

        _cts      = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _loopTask = Task.Run(() => LoopAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _adapter.PresenceReceived -= OnPresenceEvent;
        _adapter.GatewaySnapshot  -= OnSnapshot;
        _adapter.GatewaySeqGap    -= OnSeqGap;

        _cts?.Cancel();
        if (_loopTask is not null)
        {
            try { await _loopTask.WaitAsync(ct); }
            catch (OperationCanceledException) { }
        }
    }

    public void Dispose() => _cts?.Dispose();

    // ── Push event handlers ────────────────────────────────────────────────────

    private void OnPresenceEvent(JsonElement payload)
    {
        // Payload structure: {presence: [...]}
        if (!payload.TryGetProperty("presence", out var arr) ||
            arr.ValueKind != JsonValueKind.Array)
            return;

        var entries = ParsePresenceArray(arr);
        var instances = NormalizePresence(entries);
        NotifyOnNodeLogin(instances);

        _store.Apply(instances);
        _logger.LogDebug("Presence push applied count={Count}", instances.Count);
    }

    private void OnSnapshot()
    {
        // Trigger a fresh fetch when the gateway sends a new snapshot frame (equivalent to
        // applying hello.snapshot.presence in macOS — we re-fetch instead to avoid duplicate parsing).
        _cts?.Token.ThrowIfCancellationRequested();
        Task.Run(() => RefreshAsync(_cts?.Token ?? CancellationToken.None));
    }

    private void OnSeqGap()
    {
        Task.Run(() => RefreshAsync(_cts?.Token ?? CancellationToken.None));
    }

    // ── Poll loop ──────────────────────────────────────────────────────────────

    private async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (_connection.State == GatewayConnectionState.Connected)
                    await RefreshAsync(ct);

                await Task.Delay(PollIntervalMs, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (GatewayResponseException ex) when (ex.Message.Contains("missing scope"))
            {
                _logger.LogDebug("system-presence: scope not available ({Msg})", ex.Message);
                try { await Task.Delay(60_000, ct); }
                catch (OperationCanceledException) { return; }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("system-presence poll error: {Message}", ex.Message);
                try { await Task.Delay(BackoffOnErrorMs, ct); }
                catch (OperationCanceledException) { return; }
            }
        }
    }

    private async Task RefreshAsync(CancellationToken ct)
    {
        if (_store.IsLoading) return;
        _store.SetLoading(true);

        try
        {
            var data = await _rpc.RequestRawAsync("system-presence", null, RpcTimeoutMs, ct);

            if (data.Length == 0)
            {
                _logger.LogError("system-presence returned empty payload");
                var fallback = new List<InstanceInfo> { LocalFallbackInstance("no presence payload") };
                _store.Apply(fallback, "No presence payload from gateway; showing local fallback.");
                return;
            }

            List<GatewayPresenceEntry> decoded;
            using (var doc = JsonDocument.Parse(data))
                decoded = ParsePresenceArray(doc.RootElement);

            var instances = NormalizePresence(decoded);
            if (instances.Count == 0)
            {
                var fallback = new List<InstanceInfo> { LocalFallbackInstance("no presence entries") };
                _store.Apply(fallback, "Presence list was empty; showing local fallback.");
                return;
            }

            NotifyOnNodeLogin(instances);
            _store.Apply(instances);
            _logger.LogDebug("system-presence refreshed count={Count}", instances.Count);
        }
        catch (OperationCanceledException) { throw; }
        catch (GatewayResponseException ex) when (ex.Message.Contains("missing scope"))
        {
            // Scope not granted — not transient, back off in LoopAsync.
            _logger.LogDebug("system-presence: scope not available ({Msg})", ex.Message);
            var fallback = new List<InstanceInfo> { LocalFallbackInstance("scope not available") };
            _store.Apply(fallback, "System presence scope not available.");
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "system-presence fetch/decode failed");
            var fallback = new List<InstanceInfo> { LocalFallbackInstance("presence decode failed") };
            _store.Apply(fallback, $"Presence data invalid; showing local fallback. ({ex.Message})");
        }
    }

    // ── Normalization ──────────────────────────────────────────────────────────

    private static List<GatewayPresenceEntry> ParsePresenceArray(JsonElement arr)
    {
        var result = new List<GatewayPresenceEntry>();
        foreach (var el in arr.EnumerateArray())
        {
            result.Add(new GatewayPresenceEntry(
                Host:            GetStr(el, "host"),
                Ip:              GetStr(el, "ip"),
                Version:         GetStr(el, "version"),
                Platform:        GetStr(el, "platform"),
                Devicefamily:    GetStr(el, "devicefamily"),
                Modelidentifier: GetStr(el, "modelidentifier"),
                Mode:            GetStr(el, "mode"),
                Lastinputseconds: el.TryGetProperty("lastinputseconds", out var li) && li.ValueKind == JsonValueKind.Number ? li.GetInt32() : null,
                Reason:          GetStr(el, "reason"),
                Text:            GetStr(el, "text"),
                Ts:              el.TryGetProperty("ts", out var ts) && ts.ValueKind == JsonValueKind.Number ? ts.GetInt64() : 0,
                Instanceid:      GetStr(el, "instanceid")));
        }
        return result;
    }

    private static List<InstanceInfo> NormalizePresence(List<GatewayPresenceEntry> entries)
    {
        // id key priority: instanceid → host → ip → text → fallback
        return entries.Select(e =>
        {
            var key = e.Instanceid ?? e.Host ?? e.Ip ?? e.Text ?? $"entry-{e.Ts}";
            return new InstanceInfo(
                Id:               key,
                Host:             e.Host,
                Ip:               e.Ip,
                Version:          e.Version,
                Platform:         e.Platform,
                DeviceFamily:     e.Devicefamily,
                ModelIdentifier:  e.Modelidentifier,
                LastInputSeconds: e.Lastinputseconds,
                Mode:             e.Mode,
                Reason:           e.Reason,
                Text:             e.Text ?? "Unnamed node",
                TsMs:             (double)e.Ts);
        }).ToList();
    }

    // ── Node login notifications ───────────────────────────────────────────────

    private void NotifyOnNodeLogin(List<InstanceInfo> instances)
    {
        // fires a toast when a non-local node-connected event is new
        lock (_notifyLock)
        {
            foreach (var inst in instances)
            {
                var reason = inst.Reason?.Trim();
                if (reason != "node-connected") continue;
                if (string.Equals(inst.Mode, "local", StringComparison.OrdinalIgnoreCase)) continue;

                if (_lastPresenceById.TryGetValue(inst.Id, out var prev) &&
                    prev.Reason == "node-connected" && prev.TsMs == inst.TsMs)
                    continue;

                var lastNotified = _lastLoginNotifiedAtMs.GetValueOrDefault(inst.Id, 0);
                if (inst.TsMs <= lastNotified) continue;

                _lastLoginNotifiedAtMs[inst.Id] = inst.TsMs;

                var device = string.IsNullOrWhiteSpace(inst.Host) ? inst.Id : inst.Host;
                var req = ToastNotificationRequest.Create("Node connected", device!, null, null, null);
                if (!req.IsError)
                    _ = _notifications.ShowAsync(req.Value, CancellationToken.None);
            }

            // Refresh snapshot for next comparison
            _lastPresenceById.Clear();
            foreach (var inst in instances)
                _lastPresenceById[inst.Id] = inst;
        }
    }

    // ── Local fallback ─────────────────────────────────────────────────────────

    private static InstanceInfo LocalFallbackInstance(string reason)
    {
        var host = GetLocalHostname();
        var ip = GetPrimaryIpv4();
        var version = GetAppVersion();
        var osVer = Environment.OSVersion.Version;
        var platform = $"windows {osVer.Major}.{osVer.Minor}.{osVer.Build}";
        var ipSuffix = ip is not null ? $" ({ip})" : string.Empty;
        var text = $"Local node: {host}{ipSuffix} Â· app {version ?? "dev"}";
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        return new InstanceInfo(
            Id: $"local-{host}",
            Host: host,
            Ip: ip,
            Version: version,
            Platform: platform,
            DeviceFamily: "Windows",
            ModelIdentifier: null,
            LastInputSeconds: null,
            Mode: "local",
            Reason: reason,
            Text: text,
            TsMs: ts);
    }

    private static string GetLocalHostname()
    {
        try { return Dns.GetHostName(); }
        catch { return "this-pc"; }
    }

    private static string? GetPrimaryIpv4()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up &&
                            n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
                .Select(a => a.Address.ToString())
                .FirstOrDefault();
        }
        catch { return null; }
    }

    private static string? GetAppVersion()
    {
        try
        {
            var ver = Assembly.GetEntryAssembly()?.GetName().Version;
            return ver is not null ? $"{ver.Major}.{ver.Minor}.{ver.Build}" : null;
        }
        catch { return null; }
    }

    private static string? GetStr(JsonElement el, string name) =>
        el.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String
            ? prop.GetString()
            : null;

    // Minimal DTO
    private sealed record GatewayPresenceEntry(
        string? Host,
        string? Ip,
        string? Version,
        string? Platform,
        string? Devicefamily,
        string? Modelidentifier,
        string? Mode,
        int? Lastinputseconds,
        string? Reason,
        string? Text,
        long Ts,
        string? Instanceid);
}
