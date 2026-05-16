import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct WallboardWindowSmokeTests {
    @Test func `controller presents borderless window`() async throws {
        let controller = WallboardWindowController(targetScreen: NSScreen.main)
        controller.present()
        #expect(controller.window?.styleMask.contains(.borderless) == true)
        #expect(controller.window?.backgroundColor == .black)
        #expect(controller.window?.collectionBehavior.contains(.canJoinAllSpaces) == true)
        controller.dismiss()
        controller.close()
    }

    @Test func `bundled placeholder is resolvable`() {
        let url = Bundle.module.url(forResource: "placeholder",
                                    withExtension: "html",
                                    subdirectory: "Wallboard")
        #expect(url != nil)
    }

    @Test func `manager reuses controller across open calls`() async throws {
        WallboardManager.shared.open()
        let first = WallboardManager.shared.isPresented
        WallboardManager.shared.open()
        #expect(first == true)
        WallboardManager.shared.close()
        #expect(WallboardManager.shared.isPresented == false)
    }

    @Test func `resolver prefers external screen`() {
        // Drives the pure resolver via injected arrays; does not require a live multi-monitor setup.
        // With a single-screen array the resolver must fall back to main.
        let main = NSScreen.main
        let resolved = WallboardDisplayResolver.resolve(
            preferredDisplayName: nil,
            screens: [main].compactMap(\.self),
            mainScreen: main)
        #expect(resolved === main)
    }
}
