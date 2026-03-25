using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.ExecApprovals;
using OpenClawWindows.Infrastructure.Gateway;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;

namespace OpenClawWindows.Infrastructure.ExecApprovals;

/// <summary>
/// Listens for "exec.approval.requested" gateway push events and presents an approval dialog.
/// </summary>
internal sealed class GatewayExecApprovalOrchestrator : IHostedService
{
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private readonly IGatewayRpcChannel _rpc;
    private readonly IExecApprovalEventSource _events;
    private readonly ILogger<GatewayExecApprovalOrchestrator> _logger;

    private DispatcherQueue? _dispatcherQueue;
    private CancellationTokenSource? _cts;

    // Serialize concurrent requests — only one dialog at a time.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public GatewayExecApprovalOrchestrator(
        IGatewayRpcChannel rpc,
        IExecApprovalEventSource events,
        ILogger<GatewayExecApprovalOrchestrator> logger)
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

        _events.ExecApprovalRequested += OnExecApprovalRequested;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        _events.ExecApprovalRequested -= OnExecApprovalRequested;
        _cts?.Cancel();
        return Task.CompletedTask;
    }

    // ── Push handler ──────────────────────────────────────────────────────────

    private void OnExecApprovalRequested(JsonElement payload)
    {
        var ct = _cts?.Token ?? default;
        _ = Task.Run(() => HandleAsync(payload, ct), CancellationToken.None);
    }

    private async Task HandleAsync(JsonElement payload, CancellationToken ct)
    {
        GatewayApprovalRequest? req;
        try
        {
            req = JsonSerializer.Deserialize<GatewayApprovalRequest>(payload, JsonOpts);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to decode exec.approval.requested payload");
            return;
        }

        if (req is null || string.IsNullOrEmpty(req.Id)) return;

        // Serialize: only one exec approval dialog at a time (matches macOS serial handling).
        await _gate.WaitAsync(ct);
        try
        {
            var decision = await ShowDialogOnUiThreadAsync(req, ct);
            if (ct.IsCancellationRequested) return;

            try
            {
                await _rpc.ExecApprovalResolveAsync(req.Id, decision.ToRawValue(), ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "exec.approval.resolve failed id={Id}", req.Id);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    // ── Dialog ────────────────────────────────────────────────────────────────

    private Task<ExecApprovalDecision> ShowDialogOnUiThreadAsync(
        GatewayApprovalRequest req,
        CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<ExecApprovalDecision>();
        var vm  = BuildViewModel(req);

        _dispatcherQueue?.TryEnqueue(async () =>
        {
            try
            {
                var hostWindow = new Window { Title = "OpenClaw — Exec Approval" };
                var grid = new global::Microsoft.UI.Xaml.Controls.Grid();
                hostWindow.Content = grid;
                hostWindow.Activate();

                var xr = grid.XamlRoot ?? await WaitForXamlRootAsync(grid);
                if (xr is null)
                {
                    _logger.LogWarning("XamlRoot unavailable for exec approval dialog");
                    tcs.TrySetResult(ExecApprovalDecision.Deny);
                    hostWindow.Close();
                    return;
                }

                var dialog = new ExecApprovalDialog(vm) { XamlRoot = xr };
                await dialog.ShowAsync();

                tcs.TrySetResult(dialog.DialogResult);
                hostWindow.Close();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Exec approval dialog error");
                tcs.TrySetResult(ExecApprovalDecision.Deny);
            }
        });

        return tcs.Task;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static ExecApprovalViewModel BuildViewModel(GatewayApprovalRequest req)
    {
        var inner   = req.Request;
        var command = inner?.Command?.Trim() is { Length: > 0 } c ? c : req.Id;
        return new ExecApprovalViewModel(command, inner?.SessionKey, inner?.AgentId);
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

    // ── DTOs

    private sealed class GatewayApprovalRequest
    {
        [JsonPropertyName("id")]          public string           Id          { get; set; } = "";
        [JsonPropertyName("request")]     public ApprovalRequest? Request     { get; set; }
        [JsonPropertyName("createdAtMs")] public long             CreatedAtMs { get; set; }
        [JsonPropertyName("expiresAtMs")] public long             ExpiresAtMs { get; set; }
    }

    private sealed class ApprovalRequest
    {
        [JsonPropertyName("command")]    public string?  Command    { get; set; }
        [JsonPropertyName("sessionKey")] public string?  SessionKey { get; set; }
        [JsonPropertyName("agentId")]    public string?  AgentId    { get; set; }
    }
}

file static class ExecApprovalDecisionExtensions
{
    // Maps domain enum to the wire string expected by exec.approval.resolve.
    internal static string ToRawValue(this ExecApprovalDecision d) => d switch
    {
        ExecApprovalDecision.AllowOnce   => "allow-once",
        ExecApprovalDecision.AllowAlways => "allow-always",
        _                                => "deny",
    };
}
