import AppKit
import WebKit

extension CanvasWindowController {
    // MARK: - WKUIDelegate

    /// Bridges `<input type="file">` clicks in canvas HTML to a native `NSOpenPanel`.
    /// Without a `WKUIDelegate`, WebKit silently drops the request and file-picker
    /// buttons in canvas pages do nothing.
    @MainActor
    func webView(
        _: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame _: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void)
    {
        ControlUIDocumentHost.openPanel(
            parameters: parameters, parent: self.window, completionHandler: completionHandler)
    }
}
