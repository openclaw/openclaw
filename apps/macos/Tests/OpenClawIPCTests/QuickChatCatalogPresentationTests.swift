import AppKit
import Observation
import OpenClawChatUI
import SwiftUI
import XCTest
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
final class QuickChatCatalogPresentationTests: XCTestCase {
    func testRenderedPickerUsesCatalogAvailabilityReasoningAndSpeed() throws {
        try AppKitTestSupport.runAsyncXCTest {
            try await self.checkRenderedPickerUsesCatalogAvailabilityReasoningAndSpeed()
        }
    }

    private func checkRenderedPickerUsesCatalogAvailabilityReasoningAndSpeed() async throws {
        let application = AppKitTestSupport.application
        XCTAssertTrue(AppKitTestSupport.didSetActivationPolicy)
        if ProcessInfo.processInfo.environment["OPENCLAW_TEST_QUICKCHAT_APPEARANCE"] == "dark" {
            application.appearance = NSAppearance(named: .darkAqua)
        }
        let fixture = QuickChatCatalogFixture()
        let gateway = Self.makeGateway(fixture: fixture)
        let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "main")
        let model = QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: { try await gateway.agentsList() },
            agentIdentityProvider: { _ in .placeholder },
            permissionStatusProvider: { _ in [:] },
            connectionGateProvider: { .available },
            modelControlsProvider: { target in
                async let catalog = transport.loadModelCatalog(sessionKey: target.sessionKey, agentID: target.agentID)
                async let sessions = transport.listSessions(limit: 200, search: target.sessionKey, archived: false)
                async let agents = gateway.agentsList()
                return try await QuickChatModelControlLogic.snapshot(
                    target: target, models: catalog.choices, sessions: sessions, agents: agents)
            },
            modelCatalogEventsProvider: { await gateway.subscribe() },
            settingsPatchProvider: { target, settings in
                let routeLease = await transport.acquireSessionSettingsRouteLease()
                let lease = try XCTUnwrap(routeLease)
                return try await lease.patchSessionSettings(
                    sessionKey: target.sessionKey, agentID: target.agentID,
                    patch: settings)
            })
        let controller = QuickChatController(
            enableUI: true, model: model, monitoringEnabled: false,
            hotkeyRegistrar: { _ in }, hotkeyRemover: {})
        defer { controller.stop() }
        do {
            application.deactivate()
            controller.present()
            try await self.waitForModel { model.canUseModelControls }
            XCTAssertTrue(model.speed.supportsFastMode)
            model.selectModel("fixture/current")
            XCTAssertNil(model.selectedModelSelectionID, "Retained metadata does not permit manual selection")
            let panel = try XCTUnwrap(application.windows.first {
                ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
            })
            XCTAssertTrue(panel.isVisible)
            let content = try XCTUnwrap(panel.contentView)
            content.layoutSubtreeIfNeeded()
            let elements = try await AppKitTestSupport.accessibilityElements(in: content)
            let button = try XCTUnwrap(elements.first {
                $0.accessibilityRole?() == .button &&
                    $0.accessibilityLabel?() == "Model"
            })

            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "catalog")
                let provider = try XCTUnwrap(menu.items.first { $0.submenu != nil })
                let choices = try XCTUnwrap(provider.submenu)
                XCTAssertFalse(choices.items.contains { $0.title.hasPrefix("Current fixture") })
                let unavailable = try XCTUnwrap(choices.items.first { $0.title.hasPrefix("Locked fixture") })
                XCTAssertFalse(unavailable.isEnabled, "The catalog requires sign-in before this model can be selected")
                XCTAssertTrue(unavailable.title.contains("Sign-in needed"))
                let unknown = try XCTUnwrap(choices.items.first { $0.title.hasPrefix("Unknown fixture") })
                XCTAssertTrue(unknown.isEnabled, "Missing availability must not refuse a model")
                let allowed = try XCTUnwrap(choices.items.firstIndex { $0.title.hasPrefix("Allowed fixture") })
                XCTAssertTrue(choices.items[allowed].isEnabled)
                choices.performActionForItem(at: allowed)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertEqual(model.selectedModelSelectionID, "fixture/allowed")
            XCTAssertEqual(model.displayedModelSelectionID, "fixture/allowed")

            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "selected")
                let provider = try XCTUnwrap(menu.items.first { $0.submenu != nil })
                let selected = try XCTUnwrap(provider.submenu?.items.first {
                    $0.title.hasPrefix("Allowed fixture")
                })
                XCTAssertEqual(selected.state, .on)
            }

            var effort = try await self.waitForEffort(in: panel, value: "Inherited Brief")
            XCTAssertEqual(model.thinkingOptions.map(\.label), ["Brief", "Thorough"])
            XCTAssertTrue(effort.accessibilityPerformPress?() == true)
            let popover = try await self.waitForEffortPopover(application: application)
            let slider = try XCTUnwrap(popover.elements.first {
                $0.accessibilityRole?() == .slider && $0.accessibilityLabel?() == "Thinking effort"
            })
            XCTAssertTrue(slider.accessibilityPerformIncrement?() == true)
            try await self.waitForModel { model.selectedThinkingLevel == "high" }
            effort = try await self.waitForEffort(in: panel, value: "Thorough")
            let effortValue: Any? = effort.accessibilityValue?()
            XCTAssertEqual(effortValue as? String, "Thorough")
            try await self.captureEffortPopover(popover.window, name: "effort")
            let fast = try await AppKitTestSupport.waitForAccessibilityElement(
                in: popover.window, description: "the enabled Fast mode control")
            { elements in
                elements.first { $0.accessibilityLabel?() == "Fast mode" && $0.isAccessibilityEnabled?() == true }
            }
            XCTAssertTrue(fast.isAccessibilityEnabled?() == true)
            _ = fast.accessibilityPerformPress?()
            try await self.waitForModel { model.speed.isEnabled && !model.isUpdatingModel }
            XCTAssertTrue(model.speed.isEnabled)
            XCTAssertEqual(model.speed.override, .on)
            effort = try await self.waitForEffort(in: panel, value: "Thorough, Fast")
            let fastEffortValue: Any? = effort.accessibilityValue?()
            XCTAssertEqual(fastEffortValue as? String, "Thorough, Fast")
            let defaults = try await AppKitTestSupport.accessibilityElements(in: popover.window)
                .filter { $0.accessibilityRole?() == .button && $0.accessibilityLabel?() == "Use session default" }
            XCTAssertEqual(defaults.count, 2, "Thinking and speed each have their own inheritance control")
            XCTAssertTrue(try XCTUnwrap(defaults.last).accessibilityPerformPress?() == true)
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertNil(model.speed.override)
            XCTAssertFalse(model.speed.isEnabled)
            XCTAssertEqual(model.selectedThinkingLevel, "high")
            effort = try await self.waitForEffort(in: panel, value: "Thorough")
            XCTAssertTrue(effort.accessibilityPerformPress?() == true)
            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "inherited")
                let choices = try XCTUnwrap(menu.items.first { $0.title == "Fixture" }?.submenu)
                let unknown = try XCTUnwrap(choices.items.firstIndex { $0.title == "Unknown fixture" })
                choices.performActionForItem(at: unknown)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertEqual(model.displayedModelSelectionID, "fixture/unknown")
            let patches = await fixture.patches
            XCTAssertEqual(patches, ["model=fixture/allowed", "fast=true", "fast=null", "model=fixture/unknown"])
            controller.stop()
            await gateway.shutdown()
        } catch {
            controller.stop()
            await gateway.shutdown()
            throw error
        }
    }

    private func waitForEffort(in window: NSWindow, value expectedValue: String) async throws -> AnyObject {
        // Model observation can complete before SwiftUI publishes its current accessibility tree.
        try await AppKitTestSupport.waitForAccessibilityElement(
            in: window, description: "the enabled effort control with value \(expectedValue)")
        { elements in
            elements.first { element in
                let value: Any? = element.accessibilityValue?()
                return element.accessibilityLabel?() == "Effort" && element.accessibilityRole?() == .button &&
                    element.isAccessibilityEnabled?() == true && value as? String == expectedValue
            }
        }
    }

    private func waitForEffortPopover(application: NSApplication) async throws
        -> (window: NSWindow, elements: [AnyObject])
    {
        let deadline = ContinuousClock.now + .seconds(5)
        repeat {
            for window in application.windows where window.isVisible {
                let elements = try await AppKitTestSupport.accessibilityElements(in: window)
                if elements.contains(where: { $0.accessibilityRole?() == .slider }) {
                    return (window, elements)
                }
            }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        throw NSError(
            domain: "QuickChatCatalogPresentation", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The rendered effort popover did not expose its slider"])
    }

    private func captureEffortPopover(_ window: NSWindow, name: String) async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["OPENCLAW_TEST_QUICKCHAT_EXTERNAL_CAPTURE"] == "1",
              let directory = environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"] else { return }
        try await AppKitTestSupport.recordCompositedWindow(
            window, name: name, directory: URL(fileURLWithPath: directory, isDirectory: true))
    }

    private func waitForModel(_ condition: @escaping @MainActor () -> Bool) async throws {
        let ready = XCTestExpectation(description: "Quick Chat model state settled")
        let observation = QuickChatCatalogObservation(condition: condition, ready: ready)
        observation.observe()
        let result = await XCTWaiter.fulfillment(of: [ready], timeout: 5)
        observation.stop()
        XCTAssertEqual(result, .completed)
        XCTAssertTrue(condition())
    }

    private static func makeGateway(fixture: QuickChatCatalogFixture) -> GatewayConnection {
        // Real request encoding and payload decoding stop at the owner's in-memory WebSocket fake.
        // This does not exercise a network listener, device authentication, or a live Gateway.
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(bytes): bytes
                case let .string(text): Data(text.utf8)
                @unknown default: throw URLError(.badServerResponse)
                }
                try await socket.emitReceiveSuccess(.data(fixture.response(to: data)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    capabilities: ["published-model-catalog"]))
            })
        })
        return GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
    }
}

private actor QuickChatCatalogFixture {
    private var model = "current"
    private var fastMode: Bool?
    private(set) var patches: [String] = []

    func response(to data: Data) throws -> Data {
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let id = try XCTUnwrap(request["id"] as? String)
        let method = try XCTUnwrap(request["method"] as? String)
        let payload: String
        switch method {
        case "health": payload = "{}"
        case "agents.list":
            payload = #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main","kind":"agent","name":"Fixture"}]}"#
        case "models.list":
            let params = try XCTUnwrap(request["params"] as? [String: Any])
            XCTAssertEqual(params["sessionKey"] as? String, "agent:main:main")
            payload = """
            {"models":[
              {"id":"current","name":"Current fixture","provider":"fixture","available":true,"manualSelectionAllowed":false,
               "thinkingLevels":[{"id":"low","label":"Brief"},{"id":"high","label":"Thorough"}],
               "thinkingDefault":"low","supportsFastMode":true,"effectiveFastMode":false},
              {"id":"allowed","name":"Allowed fixture","provider":"fixture","available":true,"manualSelectionAllowed":true,
               "thinkingLevels":[{"id":"low","label":"Brief"},{"id":"high","label":"Thorough"}],
               "thinkingDefault":"low","supportsFastMode":true,"effectiveFastMode":false},
              {"id":"locked","name":"Locked fixture","provider":"fixture","available":false,
               "unavailableReason":"missing-auth"},
              {"id":"unknown","name":"Unknown fixture","provider":"fixture"}
            ]}
            """
        case "sessions.list":
            let fast = self.fastMode.map { ",\"fastMode\":\($0),\"effectiveFastMode\":\($0)" } ?? ""
            payload = """
            {"sessions":[{"key":"agent:main:main","modelProvider":"fixture","model":"\(self.model)"\(fast)}]}
            """
        case "sessions.patch":
            let params = try XCTUnwrap(request["params"] as? [String: Any])
            XCTAssertEqual(params["key"] as? String, "agent:main:main")
            if let model = params["model"] as? String {
                XCTAssertTrue(["fixture/allowed", "fixture/unknown"].contains(model))
                self.model = model
                self.patches.append("model=\(model)")
            } else {
                let fast = try XCTUnwrap(params["fastMode"])
                XCTAssertTrue(fast is Bool || fast is NSNull)
                self.fastMode = fast as? Bool
                self.patches.append(self.fastMode.map { "fast=\($0)" } ?? "fast=null")
            }
            payload = #"{"ok":true,"key":"agent:main:main","entry":{}}"#
        default:
            throw NSError(
                domain: "QuickChatCatalogFixture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unexpected request: \(method)"])
        }
        return Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)
    }
}

@MainActor
private final class QuickChatCatalogObservation {
    let condition: @MainActor () -> Bool
    let ready: XCTestExpectation
    private var stopped = false

    init(condition: @escaping @MainActor () -> Bool, ready: XCTestExpectation) {
        self.condition = condition
        self.ready = ready
    }

    func observe() {
        guard !self.stopped else { return }
        let satisfied = withObservationTracking { self.condition() } onChange: { [weak self] in
            Task { @MainActor in self?.observe() }
        }
        if satisfied {
            self.stopped = true
            self.ready.fulfill()
        }
    }

    func stop() {
        self.stopped = true
    }
}
