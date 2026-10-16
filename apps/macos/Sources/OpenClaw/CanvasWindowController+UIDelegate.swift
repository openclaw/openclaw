import AppKit
import WebKit

extension CanvasWindowController {
    // MARK: - WKUIDelegate

    /// WebKit defaults to prompting when this delegate method is absent.
    func webView(
        _: WKWebView,
        requestMediaCapturePermissionFor _: WKSecurityOrigin,
        initiatedByFrame _: WKFrameInfo,
        type _: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void)
    {
        decisionHandler(ControlUIDocumentHost.mediaCaptureDecision(.prompt))
    }

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
