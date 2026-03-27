using System.Text.Json;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Infrastructure.Gateway;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;

namespace OpenClawWindows.Infrastructure.Pairing;

/// <summary>
/// Queues and presents device pairing approval dialogs driven by gateway push events.
/// </summary>
internal sealed class DevicePairingApprovalOrchestrator : IHostedService, IDevicePairingPendingMonitor
{
    // Tunables
    private const int LoadTimeoutMs          = 6000;
    private const int LoadRetryMaxAttempts   = 8;
    private const int LoadRetryInitialDelayMs = 200;
    private const int LoadRetryMaxDelayMs    = 2000;

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private readonly IGatewayRpcChannel _rpc;
    private readonly IPairingEventSource _events;
    private readonly ILogger<DevicePairingApprovalOrchestrator> _logger;

    private DispatcherQueue? _dispatcherQueue;
    private CancellationTokenSource? _cts;
    private Task? _loadTask;

    // Queue state — all mutations lock(_lock).
    private readonly object _lock = new();
    private readonly List<DevicePendingRequest> _queue = [];
    private bool _presenting;
    private string? _activeRequestId;
    private readonly HashSet<string> _resolvedWhileActive = [];
    private ContentDialog? _activeDialog;   // set/cleared only on the UI thread

    // IDevicePairingPendingMonitor
    public int PendingCount      { get { lock (_lock) return _queue.Count; } }
    public int PendingRepairCount { get { lock (_lock) return _queue.Count(r => r.IsRepair == true); } }
    public event EventHandler? Changed;

    private void NotifyPendingChanged() =>
        Task.Run(() => Changed?.Invoke(this, EventArgs.Empty));

    public DevicePairingApprovalOrchestrator(
        IGatewayRpcChannel rpc,
        IPairingEventSource events,
        ILogger<DevicePairingApprovalOrchestrator> logger)
    {
        _rpc    = rpc;
        _events = events;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken ct)
    {
        // StartAsync runs on the UI thread (OnLaunched → host.StartAsync).
        _dispatcherQueue = DispatcherQueue.GetForCurrentThread();
        _cts = new CancellationTokenSource();

        _events.DevicePairRequested += OnDevicePairRequested;
        _events.DevicePairResolved  += OnDevicePairResolved;

        _loadTask = Task.Run(() => LoadPendingAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _events.DevicePairRequested -= OnDevicePairRequested;
        _events.DevicePairResolved  -= OnDevicePairResolved;

        _cts?.Cancel();
        if (_loadTask is not null)
        {
            try { await _loadTask.WaitAsync(ct); }
            catch (OperationCanceledException) { }
        }
    }

    // ── Push handlers ─────────────────────────────────────────────────────────

    private void OnDevicePairRequested(JsonElement payload)
    {
        try
        {
            var req = JsonSerializer.Deserialize<DevicePendingRequest>(payload, JsonOpts);
            if (req is null) return;
            Enqueue(req);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to decode device.pair.requested");
        }
    }

    private void OnDevicePairResolved(JsonElement payload)
    {
        try
        {
            var ev = JsonSerializer.Deserialize<PairingResolvedEvent>(payload, JsonOpts);
            if (ev is null) return;
            HandleResolved(ev.RequestId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to decode device.pair.resolved");
        }
    }

    // ── Load on startup ───────────────────────────────────────────────────────

    private async Task LoadPendingAsync(CancellationToken ct)
    {
        var delayMs = LoadRetryInitialDelayMs;
        for (var attempt = 1; attempt <= LoadRetryMaxAttempts; attempt++)
        {
            if (ct.IsCancellationRequested) return;
            try
            {
                var data = await _rpc.DevicePairListAsync(LoadTimeoutMs, ct);
                var list = JsonSerializer.Deserialize<DevicePairingList>(data, JsonOpts);
                if (list is null || list.Pending.Length == 0) return;

                _logger.LogInformation("Loaded {Count} pending device pairing request(s)", list.Pending.Length);

                // Enqueue sorted by ts descending
                foreach (var req in list.Pending.OrderByDescending(r => r.Ts))
                    Enqueue(req);
                return;
            }
            catch when (ct.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                if (attempt == LoadRetryMaxAttempts)
                {
                    _logger.LogError(ex, "Failed to load device pairing requests after {N} attempts", attempt);
                    return;
                }
                await Task.Delay(delayMs, ct).ConfigureAwait(false);
                delayMs = Math.Min(delayMs * 2, LoadRetryMaxDelayMs);
            }
        }
    }

    // ── Queue management ──────────────────────────────────────────────────────

    private void Enqueue(DevicePendingRequest req)
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
    }

    private void HandleResolved(string requestId)
    {
        ContentDialog? dialogToClose = null;
        bool removed = false;
        lock (_lock)
        {
            _resolvedWhileActive.Add(requestId);
            if (_activeRequestId == requestId)
            {
                // Dialog is currently showing — we'll close it so the loop can proceed.
                dialogToClose = _activeDialog;
                _logger.LogInformation(
                    "Device pairing resolved remotely while dialog open requestId={Id}", requestId);
            }
            else
            {
                var before = _queue.Count;
                _queue.RemoveAll(r => r.RequestId == requestId);
                _resolvedWhileActive.Remove(requestId);
                removed = _queue.Count != before;
            }
        }

        if (removed) NotifyPendingChanged();
        if (dialogToClose is not null)
            _dispatcherQueue?.TryEnqueue(() => dialogToClose.Hide());
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
                DevicePendingRequest? req;
                lock (_lock)
                {
                    req = _queue.FirstOrDefault();
                    if (req is null) { _presenting = false; return; }
                    _activeRequestId = req.RequestId;
                }

                var decision = await ShowDialogOnUiThreadAsync(req, ct);

                lock (_lock) { _activeRequestId = null; }

                if (ct.IsCancellationRequested) return;

                // Check whether a resolved push arrived while the dialog was open.
                bool wasRemotelyResolved;
                lock (_lock) { wasRemotelyResolved = _resolvedWhileActive.Remove(req.RequestId); }

                if (wasRemotelyResolved)
                {
                    lock (_lock) { _queue.RemoveAll(r => r.RequestId == req.RequestId); }
                    NotifyPendingChanged();
                    continue;
                }

                switch (decision)
                {
                    case PairingDecision.Approve:
                        lock (_lock) { _queue.RemoveAll(r => r.RequestId == req.RequestId); }
                        NotifyPendingChanged();
                        await ApproveAsync(req.RequestId, ct);
                        break;

                    case PairingDecision.Reject:
                        lock (_lock) { _queue.RemoveAll(r => r.RequestId == req.RequestId); }
                        NotifyPendingChanged();
                        await RejectAsync(req.RequestId, ct);
                        break;

                    case PairingDecision.Later:
                        // Move to end of queue
                        lock (_lock)
                        {
                            _queue.RemoveAll(r => r.RequestId == req.RequestId);
                            _queue.Add(req);
                        }
                        // Stop presenting for now; next push event will re-trigger.
                        lock (_lock) { _presenting = false; }
                        return;
                }
            }
        }
        finally
        {
            lock (_lock) { _presenting = false; }
        }
    }

    private Task<PairingDecision> ShowDialogOnUiThreadAsync(DevicePendingRequest req, CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<PairingDecision>();
        var vm  = BuildViewModel(req);

        var enqueued = _dispatcherQueue?.TryEnqueue(async () =>
        {
            try
            {
                var hostWindow = new Window { Title = "OpenClaw — Device Pairing" };
                var grid = new global::Microsoft.UI.Xaml.Controls.Grid();
                hostWindow.Content = grid;
                hostWindow.Activate();

                var xr = grid.XamlRoot ?? await WaitForXamlRootAsync(grid);
                if (xr is null)
                {
                    _logger.LogWarning("XamlRoot unavailable for device pairing dialog");
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
                _logger.LogError(ex, "Device pairing dialog error");
                lock (_lock) { _activeDialog = null; }
                tcs.TrySetResult(PairingDecision.Later);
            }
        }) ?? false;

        // If the dispatcher is unavailable or the queue is full, unblock the loop immediately.
        if (!enqueued)
            tcs.TrySetResult(PairingDecision.Later);

        return tcs.Task;
    }

    // ── RPC calls ─────────────────────────────────────────────────────────────

    private async Task ApproveAsync(string requestId, CancellationToken ct)
    {
        try { await _rpc.DevicePairApproveAsync(requestId, ct); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "DevicePairApprove failed requestId={Id}", requestId);
        }
    }

    private async Task RejectAsync(string requestId, CancellationToken ct)
    {
        try { await _rpc.DevicePairRejectAsync(requestId, ct); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "DevicePairReject failed requestId={Id}", requestId);
        }
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    private static PairingApprovalViewModel BuildViewModel(DevicePendingRequest req)
        => new(
            deviceDisplayName: req.DisplayName?.Trim() is { Length: > 0 } n ? n : req.DeviceId,
            platform:          req.Platform,
            role:              req.Role,
            scopes:            req.Scopes,
            remoteIp:          StripIpv6Prefix(req.RemoteIp),
            isRepair:          req.IsRepair == true);

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
}
