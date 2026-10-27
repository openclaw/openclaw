import Foundation
import OpenClawKit
import PeekabooAutomationKit
import Testing
@testable import OpenClaw

@MainActor
struct ComputerWindowObservationTests {
    @Test func `window executor refuses its own process before observing or focusing`() async {
        let service = ComputerWindowActionExecutor()
        service.adoptLifecycleGeneration(0)
        let ref = service.issueWindowRef(
            app: ServiceApplicationInfo(
                processIdentifier: getpid(),
                bundleIdentifier: "ai.openclaw.mac",
                name: "OpenClaw",
                windowCount: 1),
            window: ServiceWindowInfo(windowID: 77, title: "Chat", bounds: .zero))

        for action in [OpenClawComputerAction.getWindowState, .bringToFront, .getAccessibilityTree] {
            do {
                _ = try await service.perform(
                    OpenClawComputerActParams(action: action, windowRef: ref),
                    lifecycleGeneration: 0,
                    checkExecutionAllowed: {})
                Issue.record("Expected same-process refusal for \(action)")
            } catch {
                #expect(error.localizedDescription.contains("Peekaboo cannot inspect OpenClaw's own windows"))
            }
        }
    }

    @Test func `window executor rejects screenshot omission before capture`() async {
        let service = ComputerWindowActionExecutor()
        do {
            _ = try await service.perform(
                OpenClawComputerActParams(action: .getWindowState, windowRef: "window-1", includeScreenshot: false),
                lifecycleGeneration: 0,
                checkExecutionAllowed: {})
            Issue.record("Expected unsupported screenshot omission")
        } catch {
            #expect(error.localizedDescription.contains("includeScreenshot:false is unsupported by Peekaboo"))
        }
    }
}
