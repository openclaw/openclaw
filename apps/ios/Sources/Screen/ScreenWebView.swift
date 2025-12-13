import ClawdisKit
import SwiftUI
import WebKit

struct ScreenWebView: UIViewRepresentable {
    @ObservedObject var controller: ScreenController

    func makeUIView(context: Context) -> WKWebView {
        self.controller.webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // State changes are driven by ScreenController.
    }
}
