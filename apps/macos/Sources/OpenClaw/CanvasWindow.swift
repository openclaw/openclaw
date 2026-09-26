import AppKit

let canvasWindowLogger = Logger(subsystem: "ai.openclaw", category: "Canvas")

enum CanvasLayout {
    static let panelSize = NSSize(width: 520, height: 680)
    static let defaultPadding: CGFloat = 10
    static let minPanelSize = NSSize(width: 360, height: 360)
}

final class CanvasPanel: NSPanel {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}
