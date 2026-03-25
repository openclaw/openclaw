using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Events;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;
using Windows.Graphics;
using WinUIEx;

namespace OpenClawWindows.Presentation.Tray;

internal sealed class TrayIconPresenter : IDisposable,
    INotificationHandler<TrayMenuStateChangedEvent>
{
    private readonly IServiceProvider _sp;
    private readonly ILogger<TrayIconPresenter> _logger;
    private readonly HoverHUDController _hoverHUD;
    private readonly DispatcherQueue _mainQueue;
    private readonly IWebChatManager _webChat;
    private TrayIcon? _trayIcon;
    private SystemTrayViewModel? _viewModel;
    private TrayContextMenuWindow? _menuWindow;
    private bool _initialized;

    // Tunables
    private const int TooltipMaxLength = 127; // Windows API limit for tray tooltip text
    private const int DataFetchDelayMs = 50;  // brief yield for cached data to arrive

    public TrayIconPresenter(IServiceProvider sp, ILogger<TrayIconPresenter> logger,
        HoverHUDController hoverHUD, DispatcherQueue mainQueue, IWebChatManager webChat)
    {
        _sp = sp;
        _logger = logger;
        _hoverHUD = hoverHUD;
        _mainQueue = mainQueue;
        _webChat = webChat;
    }

    public void Show()
    {
        if (_initialized) return;
        _initialized = true;

        try
        {
            _viewModel = _sp.GetRequiredService<SystemTrayViewModel>();

            // Pre-create menu window once — reuse via Hide/Show to avoid post-idle creation crashes.
            _menuWindow = new TrayContextMenuWindow(_viewModel);

            var iconPath = GetIconPath(GatewayState.Disconnected);
            _trayIcon = new TrayIcon(1, iconPath, FormatTooltip(GatewayState.Disconnected, null));
            _trayIcon.IsVisible = true;

            // Left click → toggle chat panel (macOS: toggleWebChatPanel).
            // Right click → context menu.
            _trayIcon.Selected += OnTraySelected;
            _trayIcon.ContextMenu += OnTrayContextMenu;

            _logger.LogInformation("Tray icon initialized (WinUIEx.TrayIcon)");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Tray icon initialization failed — continuing in degraded mode");
        }
    }

    public Task Handle(TrayMenuStateChangedEvent notification, CancellationToken ct)
    {
        if (_trayIcon is null) return Task.CompletedTask;

        var iconPath = GetIconPath(notification.State);
        var tooltip = FormatTooltip(notification.State, notification.ActiveSessionLabel);
        _mainQueue.TryEnqueue(() =>
        {
            _trayIcon.SetIcon(iconPath);
            _trayIcon.Tooltip = tooltip;
            _viewModel?.OnStateChanged(notification.State, notification.ActiveSessionLabel);
        });

        return Task.CompletedTask;
    }

    // Left click
    private void OnTraySelected(TrayIcon sender, TrayIconEventArgs e)
    {
        _mainQueue.TryEnqueue(ShowChatPanel);
    }

    private void OnTrayContextMenu(TrayIcon sender, TrayIconEventArgs e)
    {
        _mainQueue.TryEnqueue(ShowMenuPopup);
    }

    // Non-blocking: if panel already exists, toggle without RPC; timeout protects against gateway stalls.
    private async void ShowChatPanel()
    {
        try
        {
            _hoverHUD.Dismiss("trayLeftClick");
            GetCursorPos(out var pt);
            var anchor = new PointInt32(pt.X, pt.Y);

            // Fast path: if panel already exists, toggle it without waiting for RPC.
            if (_webChat.HasPanel)
            {
                await _webChat.TogglePanelAsync(_webChat.CurrentPanelSessionKey ?? "main", anchor);
                return;
            }

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var sessionKey = await _webChat.GetPreferredSessionKeyAsync(cts.Token);
            await _webChat.TogglePanelAsync(sessionKey, anchor);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ShowChatPanel failed");
        }
    }

    // async void on UI thread,
    // fire-and-forget data fetch, brief yield, then position and activate.
    private async void ShowMenuPopup()
    {
        _logger.LogInformation("ShowMenuPopup — start");
        if (_viewModel is null || _menuWindow is null) return;

        try
        {
            _hoverHUD.Dismiss("trayClick");

            // Fire-and-forget data fetch on UI thread — no Task.Run.
            _ = _menuWindow.PrepareAsync();

            // Brief yield to let cached data arrive before showing.
            await Task.Delay(DataFetchDelayMs);

            _menuWindow.ShowAtCursor();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ShowMenuPopup failed");
        }
    }

    private static string FormatTooltip(GatewayState state, string? sessionLabel)
    {
        var stateLabel  = StateLabel(state);
        var sessionPart = string.IsNullOrWhiteSpace(sessionLabel) ? "No active session" : sessionLabel;
        var full        = $"OpenClaw — {stateLabel} | {sessionPart}";

        // Enforce Windows API limit
        return full.Length <= TooltipMaxLength
            ? full
            : string.Concat(full.AsSpan(0, TooltipMaxLength - 3), "...");
    }

    private static string GetIconPath(GatewayState state)
    {
        var name = state switch
        {
            GatewayState.Connected       => "tray_connected.ico",
            GatewayState.Connecting      => "tray_reconnecting.ico",
            GatewayState.Paused          => "tray_paused.ico",
            GatewayState.Reconnecting    => "tray_reconnecting.ico",
            GatewayState.VoiceWakeActive => "tray_voice.ico",
            _                            => "tray_disconnected.ico",
        };
        return Path.Combine(AppContext.BaseDirectory, "Assets", "Icons", name);
    }

    private static string StateLabel(GatewayState state) => state switch
    {
        GatewayState.Connected       => "Connected",
        GatewayState.Connecting      => "Connecting…",
        GatewayState.Paused          => "Paused",
        GatewayState.Reconnecting    => "Reconnecting…",
        GatewayState.VoiceWakeActive => "Voice Wake",
        _                            => "Disconnected",
    };

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetCursorPos(out NativePoint lpPoint);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct NativePoint { public int X; public int Y; }

    public void Dispose()
    {
        _trayIcon?.Dispose();
        _trayIcon = null;
    }
}
