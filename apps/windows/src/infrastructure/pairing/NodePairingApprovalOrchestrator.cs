using System.Net.Sockets;
using System.Text.Json;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Notifications;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;

namespace OpenClawWindows.Infrastructure.Pairing;

/// <summary>
/// Queues and presents node pairing approval dialogs with 15 s reconciliation and silent SSH auto-approve.
/// </summary>
internal sealed class NodePairingApprovalOrchestrator : IHostedService, INodePairingPendingMonitor
{
    // Tunables
    private const int ReconcileIntervalMs    = 15_000;
    private const int ReconcileResyncDelayMs = 250;
    private const int LoadTimeoutMs          = 6_000;
    private const int ReconcileTimeoutMs     = 2_500;
    private const int LoadRetryMaxAttempts   = 8;
    private const int LoadRetryInitialDelayMs = 200;
    private const int LoadRetryMaxDelayMs    = 2_000;
    private const int SshProbeTimeoutMs      = 5_000;

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private readonly IGatewayRpcChannel _rpc;
    private readonly IPairingEventSource _events;
    private readonly ISettingsRepository _settings;
    private readonly INotificationProvider _notifications;
    private readonly ILogger<NodePairingApprovalOrchestrator> _logger;

    private DispatcherQueue? _dispatcherQueue;
    private CancellationTokenSource? _cts;
    private Task? _loadTask;
    private Task? _reconcileLoopTask;
    private CancellationTokenSource? _resyncCts;

    // Queue state — all mutations lock(_lock).
    private readonly object _lock = new();
    private readonly List<NodePendingRequest> _queue = [];
    private bool _presenting;
    private bool _reconcileInFlight;
    private string? _activeRequestId;
    private readonly Dictionary<string, string> _remoteResolutionsByRequestId = [];
    private readonly HashSet<string> _autoApproveAttempts = [];
    private ContentDialog? _activeDialog;

    // INodePairingPendingMonitor
    public int PendingCount      { get { lock (_lock) return _queue.Count; } }
    public int PendingRepairCount { get { lock (_lock) return _queue.Count(r => r.IsRepair == true); } }
    public event EventHandler? Changed;

    private void NotifyPendingChanged() =>
        Task.Run(() => Changed?.Invoke(this, EventArgs.Empty));

    public NodePairingApprovalOrchestrator(
        IGatewayRpcChannel rpc,
        IPairingEventSource events,
        ISettingsRepository settings,
        INotificationProvider notifications,
        ILogger<NodePairingApprovalOrchestrator> logger)
    {
        _rpc           = rpc;
        _events        = events;
        _settings      = settings;
        _notifications = notifications;
        _logger        = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        // StartAsync runs on the UI thread (OnLaunched → host.StartAsync).
        _dispatcherQueue = DispatcherQueue.GetForCurrentThread();
        _cts = new CancellationTokenSource();

        _events.NodePairRequested += OnNodePairRequested;
        _events.NodePairResolved  += OnNodePairResolved;
        _events.GatewaySnapshot   += OnGatewaySnapshot;
        _events.GatewaySeqGap     += OnGatewaySeqGap;

        _loadTask = Task.Run(() => LoadPendingAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _events.NodePairRequested -= OnNodePairRequested;
        _events.NodePairResolved  -= OnNodePairResolved;
        _events.GatewaySnapshot   -= OnGatewaySnapshot;
        _events.GatewaySeqGap     -= OnGatewaySeqGap;

        _cts?.Cancel();
        _resyncCts?.Cancel();

        foreach (var t in new[] { _loadTask, _reconcileLoopTask })
        {
            if (t is null) continue;
            try { await t.WaitAsync(ct); }
            catch (OperationCanceledException) { }
        }
    }

    // ── Push handlers ─────────────────────────────────────────────────────────

    private void OnNodePairRequested(JsonElement payload)
    {
        try
        {
            var req = JsonSerializer.Deserialize<NodePendingRequest>(payload, JsonOpts);
            if (req is null) return;
            Enqueue(req);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to decode node.pair.requested");
        }
    }

    private void OnNodePairResolved(JsonElement payload)
    {
        try
        {
            var ev = JsonSerializer.Deserialize<PairingResolvedEvent>(payload, JsonOpts);
            if (ev is null) return;
            HandleResolved(ev.RequestId, ev.Decision);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to decode node.pair.resolved");
        }
    }

    private void OnGatewaySnapshot() => ScheduleResync(delayMs: 0);

    private void OnGatewaySeqGap() => ScheduleResync(delayMs: ReconcileResyncDelayMs);

    // ── Load on startup ───────────────────────────────────────────────────────

    private async Task LoadPendingAsync(CancellationToken ct)
    {
        var delayMs = LoadRetryInitialDelayMs;
        for (var attempt = 1; attempt <= LoadRetryMaxAttempts; attempt++)
        {
            if (ct.IsCancellationRequested) return;
            try
            {
                var list = await FetchPairingListAsync(LoadTimeoutMs, ct);
                if (list.Pending.Length == 0) return;

                _logger.LogInformation("Loaded {Count} pending node pairing request(s)", list.Pending.Length);
                await ApplyListAsync(list, ct);
                return;
            }
            catch when (ct.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                if (attempt == LoadRetryMaxAttempts)
                {
                    _logger.LogError(ex, "Failed to load node pairing requests after {N} attempts", attempt);
                    return;
                }
                await Task.Delay(delayMs, ct).ConfigureAwait(false);
                delayMs = Math.Min(delayMs * 2, LoadRetryMaxDelayMs);
            }
        }
    }

    // ── Reconciliation ────────────────────────────────────────────────────────

    private void ScheduleResync(int delayMs)
    {
        _resyncCts?.Cancel();
        _resyncCts = new CancellationTokenSource();
        var token = _resyncCts.Token;

        _ = Task.Run(async () =>
        {
            if (delayMs > 0)
            {
                try { await Task.Delay(delayMs, token); }
                catch (OperationCanceledException) { return; }
            }
            await ReconcileOnceAsync(ReconcileTimeoutMs, token);
        }, CancellationToken.None);
    }

    private void UpdateReconcileLoop()
    {
        var ct = _cts?.Token ?? default;
        bool shouldPoll;
        lock (_lock) { shouldPoll = _queue.Count > 0 || _presenting; }

        if (shouldPoll)
        {
            if (_reconcileLoopTask is null or { IsCompleted: true })
                _reconcileLoopTask = Task.Run(() => ReconcileLoopAsync(ct), CancellationToken.None);
        }
        else
        {
            // Let the running loop exit naturally — it checks ShouldPoll each iteration
        }
    }

    private async Task ReconcileLoopAsync(CancellationToken ct)
    {
        // Polls node.pair.list every 15 s while there are pending dialogs or an active dialog.
        while (!ct.IsCancellationRequested)
        {
            bool shouldPoll;
            lock (_lock) { shouldPoll = _queue.Count > 0 || _presenting; }
            if (!shouldPoll) return;

            await ReconcileOnceAsync(ReconcileTimeoutMs, ct);

            try { await Task.Delay(ReconcileIntervalMs, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task ReconcileOnceAsync(int timeoutMs, CancellationToken ct)
    {
        lock (_lock)
        {
            if (_reconcileInFlight) return;
            _reconcileInFlight = true;
        }
        try
        {
            var list = await FetchPairingListAsync(timeoutMs, ct);
            await ApplyListAsync(list, ct);
        }
        catch { /* best-effort — transient connectivity failures are ignored */ }
        finally
        {
            lock (_lock) { _reconcileInFlight = false; }
        }
    }

    private async Task<NodePairingList> FetchPairingListAsync(int timeoutMs, CancellationToken ct)
    {
        var data = await _rpc.NodePairListAsync(timeoutMs, ct);
        return JsonSerializer.Deserialize<NodePairingList>(data, JsonOpts)
            ?? new NodePairingList([], null);
    }

    private async Task ApplyListAsync(NodePairingList list, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return;

        var pendingById = list.Pending.ToDictionary(r => r.RequestId);

        // Enqueue any new requests — covers missed pushes while reconnecting.
        foreach (var req in list.Pending.OrderBy(r => r.Ts))
            Enqueue(req);

        // Detect requests resolved elsewhere (approved/rejected on another machine).
        List<NodePendingRequest> resolvedElsewhere = [];
        lock (_lock)
        {
            foreach (var req in _queue)
            {
                if (pendingById.ContainsKey(req.RequestId)) continue;
                resolvedElsewhere.Add(req);
            }
        }

        foreach (var req in resolvedElsewhere)
        {
            var resolution = InferResolution(req, list);

            ContentDialog? dialogToClose = null;
            lock (_lock)
            {
                if (_activeRequestId == req.RequestId)
                {
                    // Dialog is currently showing — store resolution and close it.
                    _remoteResolutionsByRequestId[req.RequestId] = resolution;
                    dialogToClose = _activeDialog;
                    _logger.LogInformation(
                        "Node pairing resolved elsewhere; closing dialog requestId={Id} resolution={R}",
                        req.RequestId, resolution);
                }
                else
                {
                    _queue.RemoveAll(r => r.RequestId == req.RequestId);
                }
            }

            if (dialogToClose is not null)
                _dispatcherQueue?.TryEnqueue(() => dialogToClose.Hide());
            else
                await NotifyAsync(resolution, req, "remote", ct);
        }

        lock (_lock) { if (_queue.Count == 0) _presenting = false; }
        TriggerPresent();
        UpdateReconcileLoop();
    }

    private static string InferResolution(NodePendingRequest req, NodePairingList list)
    {
        var paired = list.Paired ?? [];
        var node = paired.FirstOrDefault(p => p.NodeId == req.NodeId);
        if (node is null) return "rejected";

        if (req.IsRepair == true && node.ApprovedAtMs.HasValue)
            return node.ApprovedAtMs.Value >= req.Ts ? "approved" : "rejected";

        return "approved";
    }

    // ── Queue management ──────────────────────────────────────────────────────

    private void Enqueue(NodePendingRequest req)
    {
        bool added;
        lock (_lock)
        {
            if (_queue.Any(r => r.RequestId == req.RequestId))
            {
                added = false;
            }
            else
            {
                _queue.Add(req);
                added = true;
            }
        }
        if (added) NotifyPendingChanged();
        TriggerPresent();
        UpdateReconcileLoop();
    }

    private void HandleResolved(string requestId, string decision)
    {
        NodePendingRequest? queuedReq = null;
        ContentDialog? dialogToClose  = null;

        lock (_lock)
        {
            if (_activeRequestId == requestId)
            {
                _remoteResolutionsByRequestId[requestId] = decision;
                dialogToClose = _activeDialog;
                _logger.LogInformation(
                    "Node pairing resolved remotely while dialog open requestId={Id}", requestId);
            }
            else
            {
                queuedReq = _queue.FirstOrDefault(r => r.RequestId == requestId);
                _queue.RemoveAll(r => r.RequestId == requestId);
                if (_queue.Count == 0) _presenting = false;
            }
        }

        if (queuedReq is not null) NotifyPendingChanged();

        if (dialogToClose is not null)
        {
            _dispatcherQueue?.TryEnqueue(() => dialogToClose.Hide());
        }
        else if (queuedReq is not null)
        {
            _ = NotifyAsync(decision, queuedReq, "remote", _cts?.Token ?? default);
        }

        TriggerPresent();
        UpdateReconcileLoop();
    }

    // ── Dialog presentation ───────────────────────────────────────────────────

    private void TriggerPresent()
    {
        lock (_lock)
        {
            if (_presenting || _queue.Count == 0) return;
            _presenting = true;
        }
        _ = Task.Run(PresentNextLoopAsync, _cts?.Token ?? default);
    }

    private async Task PresentNextLoopAsync()
    {
        var ct = _cts?.Token ?? default;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                NodePendingRequest? req;
                lock (_lock)
                {
                    req = _queue.FirstOrDefault();
                    if (req is null) { _presenting = false; return; }
                    _activeRequestId = req.RequestId;
                }

                // Attempt silent SSH auto-approve before showing the dialog.
                if (await TrySilentApproveAsync(req, ct))
                {
                    lock (_lock)
                    {
                        _activeRequestId = null;
                        _queue.RemoveAll(r => r.RequestId == req.RequestId);
                    }
                    UpdateReconcileLoop();
                    continue;
                }

                var decision = await ShowDialogOnUiThreadAsync(req, ct);

                lock (_lock) { _activeRequestId = null; }

                if (ct.IsCancellationRequested) return;

                // Check if resolved remotely while dialog was open.
                string? remoteDecision;
                lock (_lock) { _remoteResolutionsByRequestId.Remove(req.RequestId, out remoteDecision); }

                if (remoteDecision is not null)
                {
                    lock (_lock) { _queue.RemoveAll(r => r.RequestId == req.RequestId); }
                    await NotifyAsync(remoteDecision, req, "remote", ct);
                    UpdateReconcileLoop();
                    continue;
                }

                switch (decision)
                {
                    case PairingDecision.Approve:
                        lock (_lock) { _queue.RemoveAll(r => r.RequestId == req.RequestId); }
                        NotifyPendingChanged();
                        if (await ApproveAsync(req.RequestId, ct))
                            await NotifyAsync("approved", req, "local", ct);
                        break;

                    case PairingDecision.Reject:
                        lock (_lock) { _queue.RemoveAll(r => r.RequestId == req.RequestId); }
                        NotifyPendingChanged();
                        await RejectAsync(req.RequestId, ct);
                        await NotifyAsync("rejected", req, "local", ct);
                        break;

                    case PairingDecision.Later:
                        // Node "Later" removes from queue — gateway TTL manages expiry.
                        lock (_lock) { _queue.RemoveAll(r => r.RequestId == req.RequestId); }
                        NotifyPendingChanged();
                        break;
                }

                UpdateReconcileLoop();
            }
        }
        finally
        {
            lock (_lock) { _presenting = false; }
        }
    }

    private Task<PairingDecision> ShowDialogOnUiThreadAsync(NodePendingRequest req, CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<PairingDecision>();
        var vm  = BuildViewModel(req);

        var enqueued = _dispatcherQueue?.TryEnqueue(async () =>
        {
            try
            {
                var hostWindow = new Window { Title = "OpenClaw — Node Pairing" };
                var grid = new global::Microsoft.UI.Xaml.Controls.Grid();
                hostWindow.Content = grid;
                hostWindow.Activate();

                var xr = grid.XamlRoot ?? await WaitForXamlRootAsync(grid);
                if (xr is null)
                {
                    _logger.LogWarning("XamlRoot unavailable for node pairing dialog");
                    tcs.TrySetResult(PairingDecision.Later);
                    hostWindow.Close();
                    return;
                }

                var dialog = new PairingApprovalDialog(vm) { XamlRoot = xr };
                lock (_lock) { _activeDialog = dialog; }

                await dialog.ShowAsync();

                lock (_lock) { _activeDialog = null; }
                tcs.TrySetResult(dialog.DialogResult);
                hostWindow.Close();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Node pairing dialog error");
                lock (_lock) { _activeDialog = null; }
                tcs.TrySetResult(PairingDecision.Later);
            }
        }) ?? false;

        // If the dispatcher is unavailable or the queue is full, unblock the loop immediately.
        if (!enqueued)
            tcs.TrySetResult(PairingDecision.Later);

        return tcs.Task;
    }

    // ── Silent SSH auto-approve ───────────────────────────────────────────────

    private async Task<bool> TrySilentApproveAsync(NodePendingRequest req, CancellationToken ct)
    {
        if (req.Silent != true) return false;

        lock (_lock)
        {
            if (_autoApproveAttempts.Contains(req.RequestId)) return false;
            _autoApproveAttempts.Add(req.RequestId);
        }

        var target = await ResolveSshTargetAsync(ct);
        if (target is null)
        {
            _logger.LogInformation("Silent pairing skipped (no SSH target) requestId={Id}", req.RequestId);
            return false;
        }

        var sshOk = await ProbePortAsync(target.Value.host, target.Value.port, ct);
        if (!sshOk)
        {
            _logger.LogInformation("Silent pairing SSH probe failed requestId={Id}", req.RequestId);
            return false;
        }

        var approved = await ApproveAsync(req.RequestId, ct);
        if (!approved)
        {
            _logger.LogInformation("Silent pairing approve RPC failed requestId={Id}", req.RequestId);
            return false;
        }

        await NotifyAsync("approved", req, "silent-ssh", ct);
        return true;
    }

    private async Task<(string host, int port)?> ResolveSshTargetAsync(CancellationToken ct)
    {
        try
        {
            var settings = await _settings.LoadAsync(ct);
            var target   = settings.RemoteTarget?.Trim();
            if (string.IsNullOrEmpty(target)) return null;
            return ParseSshTarget(target);
        }
        catch { return null; }
    }

    private static (string host, int port)? ParseSshTarget(string target)
    {
        // Accepts: "user@host", "user@host:port", "identityPath@user@host[:port]"
        var atParts = target.Split('@');
        if (atParts.Length < 2) return null;
        var hostPart = atParts[^1].Trim();

        var colonIdx = hostPart.LastIndexOf(':');
        string host;
        int port = 22;
        if (colonIdx > 0 && int.TryParse(hostPart[(colonIdx + 1)..], out var p))
        {
            host = hostPart[..colonIdx];
            port = p;
        }
        else
        {
            host = hostPart;
        }

        return string.IsNullOrEmpty(host) ? null : (host, port);
    }

    private static async Task<bool> ProbePortAsync(string host, int port, CancellationToken ct)
    {
        try
        {
            using var tcp = new TcpClient();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(SshProbeTimeoutMs);
            await tcp.ConnectAsync(host, port, timeout.Token);
            return true;
        }
        catch { return false; }
    }

    // ── RPC calls ─────────────────────────────────────────────────────────────

    private async Task<bool> ApproveAsync(string requestId, CancellationToken ct)
    {
        try
        {
            await _rpc.NodePairApproveAsync(requestId, ct);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "NodePairApprove failed requestId={Id}", requestId);
            return false;
        }
    }

    private async Task RejectAsync(string requestId, CancellationToken ct)
    {
        try { await _rpc.NodePairRejectAsync(requestId, ct); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "NodePairReject failed requestId={Id}", requestId);
        }
    }

    // ── Notifications ─────────────────────────────────────────────────────────

    private async Task NotifyAsync(string resolution, NodePendingRequest req, string via, CancellationToken ct)
    {
        var title = resolution == "approved" ? "Node pairing approved" : "Node pairing rejected";
        var device = req.DisplayName?.Trim() is { Length: > 0 } n ? n : req.NodeId;
        var body   = $"{device}\n(via {via})";

        var notif = ToastNotificationRequest.Create(title, body, null, null, null);
        if (notif.IsError) return;

        try { await _notifications.ShowAsync(notif.Value, ct); }
        catch { /* best-effort */ }
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    private static PairingApprovalViewModel BuildViewModel(NodePendingRequest req)
    {
        var name     = req.DisplayName?.Trim() is { Length: > 0 } n ? n : "Unknown";
        var platform = PrettyPlatform(req.Platform);
        var version  = req.Version?.Trim() is { Length: > 0 } v ? v : null;
        var ip       = StripIpv6Prefix(req.RemoteIp);

        // Compose scopes-equivalent for node: version and nodeId as informational detail.
        var detail = new List<string>();
        if (version is not null) detail.Add($"App: {version}");
        detail.Add($"ID: {req.NodeId}");

        return new PairingApprovalViewModel(
            deviceDisplayName: name,
            platform:          platform,
            role:              null,
            scopes:            detail.Count > 0 ? detail : null,
            remoteIp:          ip,
            isRepair:          req.IsRepair == true);
    }

    private static async Task<XamlRoot?> WaitForXamlRootAsync(FrameworkElement element)
    {
        if (element.XamlRoot is not null) return element.XamlRoot;
        var tcs = new TaskCompletionSource<XamlRoot?>();
        element.Loaded += (_, _) => tcs.TrySetResult(element.XamlRoot);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        timeout.Token.Register(() => tcs.TrySetResult(null));
        return await tcs.Task;
    }

    private static string? StripIpv6Prefix(string? ip)
    {
        var s = ip?.Replace("::ffff:", "", StringComparison.OrdinalIgnoreCase).Trim();
        return s is { Length: > 0 } ? s : null;
    }

    private static string? PrettyPlatform(string? platform)
    {
        var raw = platform?.Trim();
        if (string.IsNullOrEmpty(raw)) return null;
        return raw.ToLowerInvariant() switch
        {
            "macos" or "mac"  => "macOS",
            "ios"             => "iOS",
            "ipados"          => "iPadOS",
            "android"         => "Android",
            "windows"         => "Windows",
            "linux"           => "Linux",
            _                 => raw,
        };
    }
}
