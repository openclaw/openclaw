import AppKit
import SwiftUI

struct SettingsWindowChrome: NSViewRepresentable {
    let title: String

    func makeNSView(context: Context) -> NSView {
        NSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            guard let window = nsView.window else { return }
            window.title = title
            window.titleVisibility = .visible
            window.toolbar?.isVisible = false
            window.toolbarStyle = .unified
        }
    }
}
