import AppKit
import CoreGraphics
import Observation
import OpenClawChatUI
import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct QuickChatCatalogPresentationTests {
    @Test func `rendered Quick Chat preserves catalog disclosure and shortcut behavior in order`() async throws {
        try await TestIsolation.withIsolatedState {
            try await AppKitTestSupport.startApplication()
            let application = AppKitTestSupport.application
            let previousAppearance = application.appearance
            defer { application.appearance = previousAppearance }
            try await self.checkRenderedPickerUsesCatalogAvailabilityReasoningAndSpeed()
            let presentation = QuickChatPresentationTests()
            try await presentation.checkConversationDisclosurePreservesOneComposerAndItsDraft()
            try await presentation.checkShortcutPresentsAnEditorWithoutRequiringForegroundOwnership()
            try await self.checkRestrictedOperatorModelPolicyRetiresRenderedChoicesAndOpenMenu()
        }
    }

    private func checkRenderedPickerUsesCatalogAvailabilityReasoningAndSpeed() async throws {
        let application = AppKitTestSupport.application
        #expect(AppKitTestSupport.didSetActivationPolicy)
        if ProcessInfo.processInfo.environment["OPENCLAW_TEST_QUICKCHAT_APPEARANCE"] == "dark" {
            application.appearance = NSAppearance(named: .darkAqua)
        }
        let fixture = QuickChatCatalogFixture()
        let gateway = Self.makeGateway(fixture: fixture)
        let model = Self.makeModel(gateway: gateway)
        let controller = QuickChatController(
            enableUI: true, model: model, monitoringEnabled: false,
            hotkeyRegistrar: { _ in }, hotkeyRemover: {})
        defer { controller.stop() }
        do {
            application.deactivate()
            controller.present()
            try await self.waitForModel { model.canUseModelControls }
            #expect(model.speed.supportsFastMode)
            model.selectModel("fixture/current")
            #expect(model.selectedModelSelectionID == nil, "Retained metadata does not permit manual selection")
            let panel = try #require(application.windows.first {
                ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
            })
            #expect(panel.isVisible)
            let content = try #require(panel.contentView)
            content.layoutSubtreeIfNeeded()
            let button = try await self.waitForModelButton(in: panel, value: "Current fixture")

            try await AppKitTestSupport.openMenu(button, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "catalog")
                let provider = try #require(menu.items.first { $0.submenu != nil })
                let choices = try #require(provider.submenu)
                #expect(!choices.items.contains { $0.title.hasPrefix("Current fixture") })
                let unavailable = try #require(choices.items.first { $0.title.hasPrefix("Locked fixture") })
                #expect(!unavailable.isEnabled, "The catalog requires sign-in before this model can be selected")
                #expect(unavailable.title.contains("Sign-in needed"))
                let unknown = try #require(choices.items.first { $0.title.hasPrefix("Unknown fixture") })
                #expect(unknown.isEnabled, "Missing availability must not refuse a model")
                let allowed = try #require(choices.items.firstIndex { $0.title.hasPrefix("Allowed fixture") })
                #expect(choices.items[allowed].isEnabled)
                choices.performActionForItem(at: allowed)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            #expect(model.selectedModelSelectionID == "fixture/allowed")
            #expect(model.displayedModelSelectionID == "fixture/allowed")

            let selectedButton = try await self.waitForModelButton(in: panel, value: "Allowed fixture")
            try await AppKitTestSupport.openMenu(selectedButton, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "selected")
                let provider = try #require(menu.items.first { $0.submenu != nil })
                let selected = try #require(provider.submenu?.items.first {
                    $0.title.hasPrefix("Allowed fixture")
                })
                #expect(selected.state == .on)
            }

            var effort = try await self.waitForEffort(in: panel, value: "Inherited Brief")
            #expect(model.thinkingOptions.map(\.label) == ["Brief", "Thorough"])
            #expect(effort.accessibilityPerformPress?() == true)
            let popover = try await self.waitForEffortPopover(application: application)
            let slider = try #require(popover.elements.first {
                $0.accessibilityRole?() == .slider && $0.accessibilityLabel?() == "Thinking effort"
            })
            #expect(slider.accessibilityPerformIncrement?() == true)
            try await self.waitForModel { model.selectedThinkingLevel == "high" }
            effort = try await self.waitForEffort(in: panel, value: "Thorough")
            let effortValue: Any? = effort.accessibilityValue?()
            #expect(effortValue as? String == "Thorough")
            try await self.captureEffortPopover(popover.window, name: "effort")
            let fast = try await AppKitTestSupport.waitForAccessibilityElement(
                in: popover.window, description: "the enabled Fast mode control")
            { elements in
                elements.first { $0.accessibilityLabel?() == "Fast mode" && $0.isAccessibilityEnabled?() == true }
            }
            #expect(fast.isAccessibilityEnabled?() == true)
            _ = fast.accessibilityPerformPress?()
            try await self.waitForModel { model.speed.isEnabled && !model.isUpdatingModel }
            #expect(model.speed.isEnabled)
            #expect(model.speed.override == .on)
            effort = try await self.waitForEffort(in: panel, value: "Thorough, Fast")
            let fastEffortValue: Any? = effort.accessibilityValue?()
            #expect(fastEffortValue as? String == "Thorough, Fast")
            let defaults = try await AppKitTestSupport.accessibilityElements(in: popover.window)
                .filter { $0.accessibilityRole?() == .button && $0.accessibilityLabel?() == "Use session default" }
            #expect(defaults.count == 2, "Thinking and speed each have their own inheritance control")
            #expect(try #require(defaults.last).accessibilityPerformPress?() == true)
            try await self.waitForModel { !model.isUpdatingModel }
            #expect(model.speed.override == nil)
            #expect(!model.speed.isEnabled)
            #expect(model.selectedThinkingLevel == "high")
            effort = try await self.waitForEffort(in: panel, value: "Thorough")
            #expect(effort.accessibilityPerformPress?() == true)
            let inheritedButton = try await self.waitForModelButton(in: panel, value: "Allowed fixture")
            try await AppKitTestSupport.openMenu(inheritedButton, in: panel) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "inherited")
                let choices = try #require(menu.items.first { $0.title == "Fixture" }?.submenu)
                let unknown = try #require(choices.items.firstIndex { $0.title == "Unknown fixture" })
                choices.performActionForItem(at: unknown)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            #expect(model.displayedModelSelectionID == "fixture/unknown")
            let patches = await fixture.patches
            #expect(patches == ["model=fixture/allowed", "fast=true", "fast=null", "model=fixture/unknown"])
            controller.stop()
            await gateway.shutdown()
        } catch {
            controller.stop()
            await gateway.shutdown()
            throw error
        }
    }

    private func checkRestrictedOperatorModelPolicyRetiresRenderedChoicesAndOpenMenu() async throws {
        let application = AppKitTestSupport.application
        let appearance = application.appearance
        defer { application.appearance = appearance }
        application.appearance = NSAppearance(named: .aqua)
        let pointer = try #require(CGEvent(source: nil)?.location)
        defer { #expect(CGWarpMouseCursorPosition(pointer) == .success) }
        // Model selection and reset require general write, independently of the
        // restricted choices returned by this operator's Gateway catalog.
        let fixture = QuickChatCatalogFixture(restrictedCatalog: .permitted)
        let gateway = Self.makeGateway(fixture: fixture, scopes: ["operator.write"])
        let model = Self.makeModel(gateway: gateway)
        let controller = QuickChatController(
            enableUI: true, model: model, monitoringEnabled: false,
            hotkeyRegistrar: { _ in }, hotkeyRemover: {})
        defer { controller.stop() }
        do {
            controller.present()
            try await self.waitForModel { model.canUseModelControls }
            model.dismissPermissionsForSession()
            model.text = "Unsent fixture draft"
            let panel = try #require(application.windows.first {
                ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
            })
            let content = try #require(panel.contentView)
            var button = try await self.waitForModelButton(in: panel, value: model.modelControlLabel)
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(button, in: panel, requireCompositedPopup: true) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-permitted")
                let choices = try #require(menu.items.first { $0.title == "Fixture" }?.submenu)
                #expect(choices.items.map(\.title) == ["Primary fixture", "Fallback fixture", "Custom fixture"])
                #expect(menu.items.contains { $0.title == "Session default" })
                #expect(model.modelControlLabel == "Primary fixture")
                let fallback = try #require(choices.items.firstIndex { $0.title == "Fallback fixture" })
                choices.performActionForItem(at: fallback)
            }
            try await self.waitForModel { !model.isUpdatingModel && !model.isLoadingModelControls }
            #expect(model.displayedModelSelectionID == "fixture/fallback")

            let noDefault = try await fixture.prepareModelChange(.noDefault)
            noDefault()
            try await self.waitForModel { model.modelChoices.map(\.modelID) == ["custom"] && model.canUseModelControls }
            button = try await self.waitForModelButton(in: panel, value: model.modelControlLabel)
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(button, in: panel, requireCompositedPopup: true) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-null")
                #expect(!menu.items.contains { $0.title == "Session default" })
                #expect(model.displayedModelSelectionID == nil)
            }
            model.selectModel(OpenClawChatViewModel.defaultModelSelectionID)
            #expect(!model.isUpdatingModel, "An old reset action cannot bypass a null permitted default")
            try await self.waitForModel { !model.isUpdatingModel && !model.isLoadingModelControls }

            let held = AsyncTestGate()
            let invalidate = try await fixture.prepareModelChange(.holding, onHeldRead: { held.open() })
            button = try await self.waitForModelButton(in: panel, value: model.modelControlLabel)
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(
                button, in: panel, waitForDismissal: true, requireCompositedPopup: true)
            { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-open")
                invalidate()
            }
            let heldDeadline = ContinuousClock.now + .seconds(5)
            let heldTimeout = Task {
                do {
                    try await Task.sleep(until: heldDeadline, clock: .continuous)
                    held.open()
                } catch {}
            }
            await held.wait()
            heldTimeout.cancel()
            await heldTimeout.value
            try Task.checkCancellation()
            let heldReadArrived = await fixture.heldCatalogReadAt.map { $0 <= heldDeadline } == true
            #expect(heldReadArrived, "The replacement catalog read must arrive before the five-second deadline")
            await fixture.releaseHeldCatalog()
            try await self.waitForModel { model.modelControlStatusMessage != nil && !model.isLoadingModelControls }
            button = try await self.waitForModelButton(in: panel, value: model.modelControlLabel)
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(button, in: panel, requireCompositedPopup: true) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-invalidated")
                #expect(menu.items.allSatisfy { $0.action == nil && $0.submenu == nil })
            }
            #expect(model.modelChoices.isEmpty)
            #expect(model.text == "Unsent fixture draft")

            let recover = try await fixture.prepareModelChange(.permitted)
            recover()
            try await self.waitForModel { model.modelChoices.count == 3 && model.canUseModelControls }
            button = try await self.waitForModelButton(in: panel, value: model.modelControlLabel)
            try AppKitTestSupport.pointAtModelButton(button, in: panel)
            try await AppKitTestSupport.openMenu(button, in: panel, requireCompositedPopup: true) { menu in
                try AppKitTestSupport.record(menu: menu, content: content, name: "guest-model-recovered")
                #expect(menu.items.contains { $0.title == "Session default" })
            }
            let patches = await fixture.patches
            #expect(patches == ["model=fixture/fallback"])
            controller.stop()
            await gateway.shutdown()
        } catch {
            await fixture.releaseHeldCatalog()
            controller.stop()
            await gateway.shutdown()
            throw error
        }
    }

    private func waitForModelButton(in window: NSWindow, value expectedValue: String) async throws -> AnyObject {
        // SwiftUI can reuse the previous Model accessibility node for its loading indicator.
        try await AppKitTestSupport.waitForAccessibilityElement(
            in: window, description: "the enabled Model button for \(expectedValue)")
        { elements in
            elements.first { element in
                let value: Any? = element.accessibilityValue?()
                return element.accessibilityRole?() == .button && element.accessibilityLabel?() == "Model" &&
                    element.isAccessibilityEnabled?() == true && value as? String == expectedValue
            }
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
        let ready = AsyncTestGate()
        let observation = QuickChatCatalogObservation(condition: condition, ready: ready)
        let timeout = Task { @MainActor in
            do {
                try await Task.sleep(for: .seconds(5))
                ready.open()
            } catch {}
        }
        observation.observe()
        await ready.wait()
        observation.stop()
        timeout.cancel()
        await timeout.value
        try Task.checkCancellation()
        #expect(observation.satisfied)
        #expect(condition())
    }

    private static func makeModel(gateway: GatewayConnection) -> QuickChatModel {
        let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "main")
        return QuickChatModel(
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
                    target: target, models: catalog.choices, sessions: sessions, agents: agents,
                    modelSelectionPolicy: catalog.modelSelectionPolicy)
            },
            modelCatalogEventsProvider: { await gateway.subscribe() },
            settingsPatchProvider: { target, settings in
                let routeLease = await transport.acquireSessionSettingsRouteLease()
                let lease = try #require(routeLease)
                return try await lease.patchSessionSettings(
                    sessionKey: target.sessionKey, agentID: target.agentID, patch: settings)
            })
    }

    private static func makeGateway(fixture: QuickChatCatalogFixture, scopes: [String] = []) -> GatewayConnection {
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
                await fixture.attach(socket: socket)
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    capabilities: ["published-model-catalog"], scopes: scopes))
            })
        })
        return GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
    }
}

private enum QuickChatRestrictedCatalog: Equatable, Sendable {
    case permitted
    case noDefault
    case holding
    case failed
}

private actor QuickChatCatalogFixture {
    private var model = "current"
    private var fastMode: Bool?
    private var restrictedCatalog: QuickChatRestrictedCatalog?
    private weak var socket: GatewayTestWebSocketTask?
    private var sequence = 0
    private var heldReads: [CheckedContinuation<Void, Never>] = []
    private var onHeldRead: (@Sendable () -> Void)?
    private(set) var heldCatalogReadAt: ContinuousClock.Instant?
    private(set) var patches: [String] = []

    init(restrictedCatalog: QuickChatRestrictedCatalog? = nil) {
        self.restrictedCatalog = restrictedCatalog
        if restrictedCatalog != nil { self.model = "excluded" }
    }

    func attach(socket: GatewayTestWebSocketTask) {
        self.socket = socket
    }

    func prepareModelChange(
        _ mode: QuickChatRestrictedCatalog,
        onHeldRead: (@Sendable () -> Void)? = nil) throws -> @Sendable () -> Void
    {
        self.restrictedCatalog = mode
        self.onHeldRead = onHeldRead
        self.heldCatalogReadAt = nil
        self.sequence += 1
        let currentSocket = self.socket
        let socket = try #require(currentSocket)
        let frame = Data(
            """
            {"type":"event","event":"chat.metadata.changed","payload":{"modelSelectionChanged":true},"seq":\(self.sequence)}
            """.utf8)
        return { socket.emitReceiveSuccess(.data(frame)) }
    }

    func releaseHeldCatalog() {
        self.restrictedCatalog = .failed
        let reads = self.heldReads
        self.heldReads.removeAll()
        reads.forEach { $0.resume() }
    }

    func response(to data: Data) async throws -> Data {
        let request = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let id = try #require(request["id"] as? String)
        let method = try #require(request["method"] as? String)
        let payload: String
        switch method {
        case "health": payload = "{}"
        case "agents.list":
            payload = #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main","kind":"agent","name":"Fixture"}]}"#
        case "models.list":
            let params = try #require(request["params"] as? [String: Any])
            #expect(params["sessionKey"] as? String == "agent:main:main")
            if self.restrictedCatalog == .holding {
                await withCheckedContinuation { continuation in
                    self.heldReads.append(continuation)
                    if self.heldCatalogReadAt == nil { self.heldCatalogReadAt = ContinuousClock.now }
                    self.onHeldRead?()
                    self.onHeldRead = nil
                }
            }
            if self.restrictedCatalog == .failed {
                return Data(#"{"type":"res","id":"\#(id)","ok":false,"error":{"code":"UNAVAILABLE","message":"Fixture catalog unavailable"}}"#.utf8)
            }
            if let restrictedCatalog {
                let models: String
                let defaultModel: String
                switch restrictedCatalog {
                case .permitted:
                    models = #"[{"id":"primary","name":"Primary fixture","provider":"fixture"},{"id":"fallback","name":"Fallback fixture","provider":"fixture"},{"id":"custom","name":"Custom fixture","provider":"fixture"}]"#
                    defaultModel = #""fixture/primary""#
                case .noDefault:
                    models = #"[{"id":"custom","name":"Custom fixture","provider":"fixture"}]"#
                    defaultModel = "null"
                case .holding, .failed:
                    throw CancellationError()
                }
                payload = """
                {"models":\(models),"modelSelectionPolicy":{"restricted":true,"defaultModel":\(defaultModel)}}
                """
                break
            }
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
            let params = try #require(request["params"] as? [String: Any])
            #expect(params["key"] as? String == "agent:main:main")
            if let model = params["model"] as? String {
                let allowed = self.restrictedCatalog == nil
                    ? ["fixture/allowed", "fixture/unknown"] : ["fixture/fallback"]
                #expect(allowed.contains(model))
                self.model = model
                self.patches.append("model=\(model)")
            } else if params["model"] is NSNull {
                self.patches.append("model=null")
                if let restrictedCatalog, restrictedCatalog != .permitted {
                    return Data(#"{"type":"res","id":"\#(id)","ok":false,"error":{"code":"FORBIDDEN","message":"No permitted default"}}"#.utf8)
                }
                self.model = self.restrictedCatalog == nil ? "current" : "primary"
            } else {
                let fast = try #require(params["fastMode"])
                #expect(fast is Bool || fast is NSNull)
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
    let ready: AsyncTestGate
    private(set) var satisfied = false
    private var stopped = false

    init(condition: @escaping @MainActor () -> Bool, ready: AsyncTestGate) {
        self.condition = condition
        self.ready = ready
    }

    func observe() {
        guard !self.stopped else { return }
        let satisfied = withObservationTracking { self.condition() } onChange: { [weak self] in
            Task { @MainActor in self?.observe() }
        }
        if satisfied {
            self.satisfied = true
            self.stopped = true
            self.ready.open()
        }
    }

    func stop() {
        self.stopped = true
    }
}
