using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Canvas;
using OpenClawWindows.Presentation.ViewModels;
using CanvasWindowUI = OpenClawWindows.Presentation.Windows.CanvasWindow;
using System.Text.Json;

namespace OpenClawWindows.Presentation.Canvas;

/// <summary>
/// Bridges IWebView2Host to a WinUI CanvasWindow + WebView2.
/// Owns the window/ViewModel lifecycle and marshals all calls to the UI dispatcher.
/// </summary>
internal sealed class WebView2CanvasAdapter : IWebView2Host
{
    // Tunables
    private const int WebViewInitTimeoutSeconds = 10;   // max wait for EnsureCoreWebView2Async

    private readonly IGatewayRpcChannel _rpcChannel;
    private readonly DispatcherQueue    _mainQueue;
    private CanvasWindowUI? _window;
    private CanvasViewModel? _vm;

    // Tracks the session key from the last PresentAsync call for A2UI bridge forwarding.
    private string? _currentSessionKey;

    public WebView2CanvasAdapter(IGatewayRpcChannel rpcChannel, DispatcherQueue mainQueue)
    {
        _rpcChannel = rpcChannel;
        _mainQueue  = mainQueue;
    }

    public async Task PresentAsync(CanvasPresentParams p, CancellationToken ct)
    {
        // Capture vm locally so a concurrent window.Closed cannot null it between steps.
        var vm = await RunOnUiAsync(() =>
        {
            EnsureWindow();
            _window!.Activate();
            return _vm!;
        });

        // Await CoreWebView2 init outside the UI enqueue to avoid stalling the dispatcher.
        await vm.WaitForReadyAsync().WaitAsync(TimeSpan.FromSeconds(WebViewInitTimeoutSeconds), ct);

        // Track session key before loading so bridge messages carry the right session.
        _currentSessionKey = ExtractSessionKey(p.Url);
        await RunOnUiAsync(() => vm.Load(p.Url));
    }

    public Task HideAsync(CancellationToken ct) =>
        RunOnUiAsync(() => _window?.AppWindow.Hide());

    public Task NavigateAsync(string url, CancellationToken ct) =>
        RunOnUiAsync(() => _vm?.Load(url));

    public Task<ErrorOr<JavaScriptEvalResult>> EvalAsync(string script, CancellationToken ct) =>
        RunOnUiAsync(async () =>
        {
            if (_vm is null)
                return (ErrorOr<JavaScriptEvalResult>)JavaScriptEvalResult.FromFailure("Canvas not initialized");
            try
            {
                var result = await _vm.EvalAsync(script);
                return (ErrorOr<JavaScriptEvalResult>)JavaScriptEvalResult.FromSuccess(result);
            }
            catch (Exception ex)
            {
                return (ErrorOr<JavaScriptEvalResult>)JavaScriptEvalResult.FromFailure(ex.Message);
            }
        });

    public Task<ErrorOr<CanvasSnapshot>> SnapshotAsync(CancellationToken ct) =>
        RunOnUiAsync(async () =>
        {
            if (_vm is null)
                return (ErrorOr<CanvasSnapshot>)Error.Failure("CVS-SNAP", "Canvas not initialized");

            var bytes = await _vm.SnapshotBytesAsync();
            if (bytes is null || bytes.Length == 0)
                return (ErrorOr<CanvasSnapshot>)Error.Failure("CVS-SNAP", "Snapshot returned empty data");

            var (w, h) = ReadPngDimensions(bytes);
            return CanvasSnapshot.Create(Convert.ToBase64String(bytes), w, h);
        });

    public Task HandleA2UIActionAsync(A2UIAction action, CancellationToken ct) =>
        RunOnUiAsync(async () =>
        {
            if (_vm is null) return;

            // Dispatch as an 'a2uiaction' CustomEvent so the page's A2UI host can process it.
            // This is the reverse direction of the WKScriptMessageHandler bridge.
            var payload = JsonSerializer.Serialize(new
            {
                eventType = "a2ui.action",
                action = new { name = action.ActionType, targetSelector = action.TargetSelector, value = action.Value }
            });

            await _vm.EvalAsync($$"""
                (function(){
                  try {
                    document.dispatchEvent(new CustomEvent('a2uiaction', {detail: {{payload}}, bubbles: true}));
                  } catch {}
                })();
                """);
        });

    // ─── Window lifecycle ──────────────────────────────────────────────────────

    // Creates a fresh CanvasWindow + CanvasViewModel pair on demand.
    // Must be called on the UI thread. Mirrors HoverHUDController.Present() pattern.
    private void EnsureWindow()
    {
        if (_window is not null) return;

        _vm = new CanvasViewModel(OnBridgeMessageReceived);
        _window = new CanvasWindowUI(_vm);

        // When the user closes the window, clear refs so the next PresentAsync recreates cleanly.
        _window.Closed += (_, _) => { _window = null; _vm = null; _currentSessionKey = null; };
    }

    // ─── A2UI bridge: page → gateway ──────────────────────────────────────────

    // Called synchronously from the UI thread when the page posts window.__a2ui.postMessage(msg).
    private void OnBridgeMessageReceived(string json)
    {
        // Fire-and-forget.
        _ = ForwardBridgeMessageAsync(json, _currentSessionKey ?? "main");
    }

    private async Task ForwardBridgeMessageAsync(string json, string sessionKey)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var body = doc.RootElement;

            // macOS extracts userAction dict: body["userAction"] ?? body
            var userAction = body.TryGetProperty("userAction", out var ua) ? ua : body;

            // Resolve action name — macOS tries extractActionName(userAction) from OpenClawCanvasA2UIAction
            string? name = null;
            if (userAction.TryGetProperty("name", out var nameEl)) name = nameEl.GetString();
            else if (userAction.TryGetProperty("actionName", out var anEl)) name = anEl.GetString();
            if (string.IsNullOrWhiteSpace(name)) return;

            var actionId = userAction.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
            if (string.IsNullOrWhiteSpace(actionId)) actionId = Guid.NewGuid().ToString();

            var surfaceId = userAction.TryGetProperty("surfaceId", out var siEl)
                ? siEl.GetString() ?? "main"
                : "main";

            var contextJson = userAction.TryGetProperty("context", out var ctxEl)
                ? ctxEl.GetRawText()
                : "{}";

            // Functional equivalent of OpenClawCanvasA2UIAction.formatAgentMessage()
            var text = $"[Canvas A2UI] action={name} surface={surfaceId} context={contextJson}";

            var invocation = new GatewayAgentInvocation(
                Message: text,
                SessionKey: sessionKey,
                Thinking: "low",
                Deliver: false,
                IdempotencyKey: actionId);

            var (ok, error) = await _rpcChannel.SendAgentAsync(invocation);

            // Dispatch status back to the page
            var capturedVm = _vm;
            if (capturedVm is not null)
            {
                var statusPayload = JsonSerializer.Serialize(new { actionId, ok, error });
                await RunOnUiAsync(async () =>
                {
                    if (_vm is null) return;
                    await _vm.EvalAsync($$"""
                        (function(){
                          try {
                            document.dispatchEvent(new CustomEvent('a2uiactionstatus', {
                              detail: {{statusPayload}}, bubbles: true
                            }));
                          } catch {}
                        })();
                        """);
                });
            }
        }
        catch
        {
            // Best-effort: never rethrows.
        }
    }

    // ─── Session key extraction ────────────────────────────────────────────────

    // Extracts the session key from a canvas:// URL (canvas://sessionKey/path).
    // Each session key maps to its own subdirectory under canvas-host.
    private static string? ExtractSessionKey(string url)
    {
        const string prefix = "canvas://";
        if (!url.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        var path = url[prefix.Length..];
        var slash = path.IndexOf('/');
        var key = slash >= 0 ? path[..slash] : path;
        return string.IsNullOrWhiteSpace(key) ? null : key;
    }

    // ─── UI-thread dispatch helpers ────────────────────────────────────────────

    private Task RunOnUiAsync(Action action)
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _mainQueue.TryEnqueue(DispatcherQueuePriority.Normal, () =>
        {
            try { action(); tcs.SetResult(); }
            catch (Exception ex) { tcs.SetException(ex); }
        });
        return tcs.Task;
    }

    private Task<T> RunOnUiAsync<T>(Func<T> func)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _mainQueue.TryEnqueue(DispatcherQueuePriority.Normal, () =>
        {
            try { tcs.SetResult(func()); }
            catch (Exception ex) { tcs.SetException(ex); }
        });
        return tcs.Task;
    }

    private Task<T> RunOnUiAsync<T>(Func<Task<T>> func)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _mainQueue.TryEnqueue(DispatcherQueuePriority.Normal, async () =>
        {
            try { tcs.SetResult(await func()); }
            catch (Exception ex) { tcs.SetException(ex); }
        });
        return tcs.Task;
    }

    private Task RunOnUiAsync(Func<Task> func)
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _mainQueue.TryEnqueue(DispatcherQueuePriority.Normal, async () =>
        {
            try { await func(); tcs.SetResult(); }
            catch (Exception ex) { tcs.SetException(ex); }
        });
        return tcs.Task;
    }

    // Reads PNG IHDR width/height without decoding the full image.
    // PNG spec: bytes 16-19 = width (big-endian uint32), bytes 20-23 = height.
    private static (int width, int height) ReadPngDimensions(byte[] png)
    {
        if (png.Length < 24) return (1, 1);
        int w = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
        int h = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
        return (Math.Max(1, w), Math.Max(1, h));
    }
}
