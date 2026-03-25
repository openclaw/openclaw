using Microsoft.Web.WebView2.Core;
using Windows.Storage.Streams;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class CanvasViewModel : ObservableObject
{
    private CoreWebView2? _coreWebView;
    // Completed once EnsureCoreWebView2Async finishes in CanvasWindow — gate for callers that need the WebView.
    private readonly TaskCompletionSource _readyTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Action<string>? _bridgeMessageCallback;

    internal CanvasViewModel(Action<string>? bridgeMessageCallback = null)
    {
        _bridgeMessageCallback = bridgeMessageCallback;
    }

    // Called by CanvasWindow.xaml.cs after EnsureCoreWebView2Async completes
    internal void Initialize(CoreWebView2 coreWebView)
    {
        _coreWebView = coreWebView;
        _readyTcs.TrySetResult();
    }

    internal Task WaitForReadyAsync() => _readyTcs.Task;

    // accepts https/http/file/canvas:// URLs
    public void Load(string url)
    {
        if (_coreWebView is null) return;

        // Map canvas:// to the virtual host registered in CanvasWindow.xaml.cs
        var navigateUrl = url.StartsWith("canvas://", StringComparison.OrdinalIgnoreCase)
            ? url.Replace("canvas://", "https://canvas.local/", StringComparison.OrdinalIgnoreCase)
            : url;

        _coreWebView.Navigate(navigateUrl);
    }

    // executes JavaScript in the web view
    public async Task<string?> EvalAsync(string script)
    {
        if (_coreWebView is null) return null;
        return await _coreWebView.ExecuteScriptAsync(script);
    }

    // captures PNG bytes for base64 encoding.
    internal async Task<byte[]?> SnapshotBytesAsync()
    {
        if (_coreWebView is null) return null;

        using var stream = new InMemoryRandomAccessStream();
        await _coreWebView.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);

        stream.Seek(0);
        var reader = new DataReader(stream.GetInputStreamAt(0));
        var size = (uint)stream.Size;
        await reader.LoadAsync(size);
        var bytes = new byte[size];
        reader.ReadBytes(bytes);
        return bytes;
    }

    // Receives messages posted from the A2UI bridge (window.__a2ui.postMessage)
    internal void OnBridgeMessage(string? json)
    {
        if (string.IsNullOrEmpty(json)) return;
        _bridgeMessageCallback?.Invoke(json);
    }

    internal void OnNavigationCompleted(bool isSuccess)
    {
        // Hook point for post-navigation actions (e.g. re-inject bridge if needed)
    }
}
