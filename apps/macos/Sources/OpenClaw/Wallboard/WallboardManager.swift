import AppKit

@MainActor
final class WallboardManager {
    static let shared = WallboardManager()
    private var controller: WallboardWindowController?

    private init() {}

    var isPresented: Bool { self.controller?.window?.isVisible == true }

    func open(preferredDisplayName: String? = nil) {
        if let existing = self.controller {
            existing.present()
            existing.loadBundledPlaceholder()
            return
        }
        let screen = WallboardDisplayResolver.resolve(preferredDisplayName: preferredDisplayName)
        let c = WallboardWindowController(targetScreen: screen)
        self.controller = c
        c.loadBundledPlaceholder()
        c.present()
    }

    func close() {
        self.controller?.dismiss()
        self.controller = nil
    }
}
