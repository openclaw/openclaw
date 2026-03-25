using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// WebView2 canvas window host — present, navigate, eval JavaScript, snapshot.
/// Implemented by WebView2CanvasAdapter (Microsoft.Web.WebView2).
/// OQ-002: SetVirtualHostNameToFolderMapping spike pending for canvas:// scheme.
/// </summary>
public interface IWebView2Host
{
    Task PresentAsync(CanvasPresentParams p, CancellationToken ct);
    Task HideAsync(CancellationToken ct);
    Task NavigateAsync(string url, CancellationToken ct);
    Task<ErrorOr<JavaScriptEvalResult>> EvalAsync(string script, CancellationToken ct);
    Task<ErrorOr<CanvasSnapshot>> SnapshotAsync(CancellationToken ct);
    Task HandleA2UIActionAsync(A2UIAction action, CancellationToken ct);
}
