using Microsoft.Web.WebView2.Core;
using OpenClawWindows.Infrastructure.Fs;
using OpenClawWindows.Presentation.Canvas;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class CanvasWindow : Window
{
    private readonly CanvasViewModel _vm;
    private CanvasFileWatcher? _canvasFileWatcher;
    private Timer? _reloadDebounce;

    // Tunables
    private const int ReloadDebounceMs = 300;   // coalesces rapid FileSystemWatcher bursts

    // Fallback scroll CSS — ensures canvas content is scrollable when the HTML lacks overflow styling.
    // Overrides any height:100%/overflow:hidden on html/body so content can scroll naturally.
    private const string ScrollFallbackScript = """
        (function(){
          var s = document.createElement('style');
          s.textContent = 'html{height:100%!important;overflow-y:auto!important;}body{min-height:100%!important;height:auto!important;overflow-y:auto!important;}';
          document.documentElement.appendChild(s);
        })();
        """;

    // A2UI bridge script injected on every navigation to expose the postMessage channel.
    private const string A2UIBridgeScript = """
        window.__a2ui = {
            postMessage: (msg) => window.chrome.webview.postMessage(JSON.stringify(msg))
        };
        """;

    public CanvasWindow(CanvasViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;
        Title = "Canvas";
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "openclaw.ico"));
        Closed += (_, _) => { _reloadDebounce?.Dispose(); _canvasFileWatcher?.Dispose(); };
        _ = InitializeWebViewAsync();
    }

    private async Task InitializeWebViewAsync()
    {
        // Canvas content lives in LocalAppData so the gateway can write session files at runtime.
        // AppContext.BaseDirectory is read-only in MSIX packaged builds, so we cannot use it (OQ-002).
        var canvasDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OpenClaw", "canvas-host");
        Directory.CreateDirectory(canvasDir);

        await WebView.EnsureCoreWebView2Async();

        // Register handler that intercepts canvas.local requests and applies traversal guard,
        // index resolution, and scaffold page.
        new CanvasSchemeHandlerAdapter(canvasDir).Attach(WebView.CoreWebView2);

        // Inject A2UI bridge before any page script runs
        await WebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(A2UIBridgeScript);

        WebView.CoreWebView2.WebMessageReceived += (_, args) =>
            _vm.OnBridgeMessage(args.TryGetWebMessageAsString());

        // Non-canvas, non-web navigations (e.g. mailto:, custom schemes) open in the system browser.
        WebView.CoreWebView2.NavigationStarting += OnNavigationStarting;

        // Watch the canvas-host directory for file changes and auto-reload when showing local content.
        _canvasFileWatcher = new CanvasFileWatcher(canvasDir, ScheduleReload);

        _vm.Initialize(WebView.CoreWebView2);
    }

    private void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)) return;
        var scheme = uri.Scheme.ToLowerInvariant();

        // Allow standard web schemes, file:// (local canvas content), and internal WebView2 schemes.
        if (scheme is "https" or "http" or "file" or "about" or "blob" or "data" or "javascript") return;

        // Resolve canvas:// → https://canvas.local/ before the filter rejects it.
        if (scheme == "canvas")
        {
            args.Cancel = true;
            var resolved = args.Uri.Replace("canvas://", "https://canvas.local/", StringComparison.OrdinalIgnoreCase);
            sender.Navigate(resolved);
            return;
        }

        // Everything else (mailto:, custom schemes, etc.) goes to the system default handler.
        args.Cancel = true;
        _ = global::Windows.System.Launcher.LaunchUriAsync(uri);
    }

    // Debounces rapid FileSystemWatcher events to avoid redundant reloads.
    private void ScheduleReload()
    {
        _reloadDebounce?.Dispose();
        _reloadDebounce = new Timer(static state =>
        {
            var self = (CanvasWindow)state!;
            self.DispatcherQueue.TryEnqueue(() =>
            {
                // Only reload while showing local canvas content (canvas.local virtual host).
                var url = self.WebView.CoreWebView2?.Source ?? string.Empty;
                if (url.StartsWith("https://canvas.local/", StringComparison.OrdinalIgnoreCase))
                    self.WebView.CoreWebView2?.Reload();
            });
        }, this, dueTime: ReloadDebounceMs, period: Timeout.Infinite);
    }

    private async void WebView_NavigationCompleted(WebView2 sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        _vm.OnNavigationCompleted(args.IsSuccess);

        // Inject scroll fallback CSS AFTER page load so it overrides the page's own styles.
        if (args.IsSuccess && WebView.CoreWebView2 is not null)
            await WebView.CoreWebView2.ExecuteScriptAsync(ScrollFallbackScript);
    }
}
