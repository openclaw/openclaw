using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;
using Windows.Graphics;

namespace OpenClawWindows.Presentation.WebChat;

/// <summary>
/// Manages the lifecycle of the web chat window and panel.
/// </summary>
internal sealed class WebChatManagerAdapter : IWebChatManager, IDisposable
{
    private readonly IGatewayRpcChannel _rpc;
    private readonly IServiceProvider   _sp;

    // Full window state
    private WebChatWindow?      _window;
    private WebChatViewModel?   _windowVm;
    private string?             _windowSessionKey;

    // Panel state
    private WebChatWindow?      _panel;
    private WebChatViewModel?   _panelVm;
    private string?             _panelSessionKey;

    private string? _cachedPreferredSessionKey;

    public string? ActiveSessionKey => _panelSessionKey ?? _windowSessionKey;
    public bool HasPanel => _panel is not null;
    public string? CurrentPanelSessionKey => _panelSessionKey;

    public WebChatManagerAdapter(IGatewayRpcChannel rpc, IServiceProvider sp)
    {
        _rpc = rpc;
        _sp  = sp;
    }

    // ── IWebChatManager ────────────────────────────────────────────────────────

    public Task ShowAsync(string sessionKey, CancellationToken ct = default)
    {
        // close panel, reuse or replace window.
        ClosePanel();

        if (_window is not null)
        {
            if (_windowSessionKey == sessionKey)
            {
                _window.Activate();
                return Task.CompletedTask;
            }
            _windowVm?.Dispose();
            _window.Close();
            _window = null;
            _windowVm = null;
            _windowSessionKey = null;
        }

        _windowVm  = _sp.GetRequiredService<WebChatViewModel>();
        _window    = new WebChatWindow(_windowVm, sessionKey, isPanel: false);
        _windowSessionKey = sessionKey;
        _window.Closed += (_, _) =>
        {
            _windowVm?.Dispose();
            _window = null;
            _windowVm = null;
            _windowSessionKey = null;
        };
        _window.Activate();
        return Task.CompletedTask;
    }

    public Task TogglePanelAsync(
        string sessionKey,
        PointInt32? anchorPoint = null,
        CancellationToken ct = default)
    {
        if (_panel is not null)
        {
            if (_panelSessionKey != sessionKey)
            {
                ClosePanel();
            }
            else
            {
                // Same session — toggle visibility.
                var appWin = _panel.AppWindow;
                if (appWin.IsVisible)
                    ClosePanel();
                else
                    PresentPanel(anchorPoint);
                return Task.CompletedTask;
            }
        }

        _panelVm  = _sp.GetRequiredService<WebChatViewModel>();
        _panel    = new WebChatWindow(_panelVm, sessionKey, isPanel: true);
        _panelSessionKey = sessionKey;
        _panel.Closed += (_, _) =>
        {
            _panel.Activated -= OnPanelActivationChanged;
            _panelVm?.Dispose();
            _panel = null;
            _panelVm = null;
            _panelSessionKey = null;
        };

        PresentPanel(anchorPoint);
        return Task.CompletedTask;
    }

    public void ClosePanel()
    {
        if (_panel is not null)
            _panel.Activated -= OnPanelActivationChanged;
        _panelVm?.Dispose();
        _panel?.Close();
        _panel = null;
        _panelVm = null;
        _panelSessionKey = null;
    }

    public void ResetAll()
    {
        ClosePanel();
        _windowVm?.Dispose();
        _window?.Close();
        _window = null;
        _windowVm = null;
        _windowSessionKey = null;
        _cachedPreferredSessionKey = null;
    }

    public async Task<string> GetPreferredSessionKeyAsync(CancellationToken ct = default)
    {
        // caches main session key for the process lifetime.
        if (_cachedPreferredSessionKey is not null) return _cachedPreferredSessionKey;
        try
        {
            var key = await _rpc.MainSessionKeyAsync(ct: ct);
            _cachedPreferredSessionKey = key;
            return key;
        }
        catch
        {
            // Gateway not yet reachable — open against "main" so the window still appears.
            // Do NOT cache so the real key is fetched once the gateway connects.
            return "main";
        }
    }

    // ── Panel presentation ─────────────────────────────────────────────────────

    private void PresentPanel(PointInt32? anchor)
    {
        if (_panel is null) return;

        if (anchor.HasValue)
            _panel.PositionNearPoint(anchor.Value);

        _panel.Activate();
        // Dismiss when user clicks elsewhere — fires when panel loses activation.
        // Replaces Win32 WH_MOUSE_LL hook that mirrored NSEvent.addGlobalMonitorForEvents.
        _panel.Activated += OnPanelActivationChanged;
    }

    private void OnPanelActivationChanged(object sender, WindowActivatedEventArgs args)
    {
        if (args.WindowActivationState == WindowActivationState.Deactivated)
            _panel?.DispatcherQueue.TryEnqueue(ClosePanel);
    }

    public void Dispose() => ResetAll();
}
