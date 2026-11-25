import AppKit
import Testing
import WebKit
@testable import OpenClaw

@MainActor
struct AppActivationTests {
    @Test(arguments: [false, true])
    func `launch policy owns activation and window ordering`(noActivate: Bool) {
        let owner = AppActivation(launchPlan: AppLaunchRuntimePlan(
            arguments: noActivate ? ["OpenClaw", "--no-activate"] : ["OpenClaw"]))
        let application = Application()
        let window = Window()

        owner.activate(application: application)
        #expect(owner.requestExternalNavigation() == !noActivate)
        owner.makeKeyAndOrderFront(window: window)
        owner.orderFrontRegardless(window: window, level: .statusBar)

        #expect(application.activations == (noActivate ? 0 : 1))
        #expect(window.operations == (noActivate ? ["back", "back"] : ["key/front", "front"]))
        #expect(window.levelsWhenOrdered == (noActivate ? [.normal, .normal] : [.floating, .statusBar]))
    }

    @Test(arguments: [false, true])
    func `automation defers media prompts without granting new permission`(noActivate: Bool) {
        let plan = AppLaunchRuntimePlan(arguments: noActivate ? ["OpenClaw", "--no-activate"] : ["OpenClaw"])
        #expect(ControlUIDocumentHost.mediaCaptureDecision(.prompt, launchPlan: plan) ==
            (noActivate ? .deny : .prompt))
        #expect(ControlUIDocumentHost.mediaCaptureDecision(.grant, launchPlan: plan) == .grant)
        #expect(ControlUIDocumentHost.mediaCaptureDecision(.deny, launchPlan: plan) == .deny)
    }

    private final class Application: AppActivationApplication {
        var activations = 0

        func activate(ignoringOtherApps: Bool) {
            #expect(ignoringOtherApps)
            self.activations += 1
        }
    }

    private final class Window: AppActivationWindow {
        var level: NSWindow.Level = .floating
        var operations: [String] = []
        var levelsWhenOrdered: [NSWindow.Level] = []

        func makeKeyAndOrderFront(_: Any?) {
            self.record("key/front")
        }

        func orderFrontRegardless() {
            self.record("front")
        }

        func orderBack(_: Any?) {
            self.record("back")
        }

        private func record(_ operation: String) {
            self.operations.append(operation)
            self.levelsWhenOrdered.append(self.level)
        }
    }
}
