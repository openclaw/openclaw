import AppKit
import CoreGraphics
import Observation
import OpenClawChatUI
import SwiftUI
import XCTest
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
final class QuickChatCatalogPresentationTests: XCTestCase {
    func testRenderedPickerUsesCatalogAvailabilityReasoningAndSpeed() async throws {
        let application = AppKitTestSupport.application
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
            let panel = try XCTUnwrap(application.windows.first {
                ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
            })
            XCTAssertTrue(panel.isVisible)
            let content = try XCTUnwrap(panel.contentView)
            content.layoutSubtreeIfNeeded()
            let elements = try await AppKitTestSupport.accessibilityElements(in: content)
            let button = try XCTUnwrap(elements.first {
                $0.accessibilityRole?() == .button &&
                    $0.accessibilityLabel?() == "Model and reasoning"
            })

            try self.press(button) { menu in
                try Self.record(menu: menu, content: content, name: "catalog")
                let provider = try XCTUnwrap(menu.items.first { $0.submenu != nil })
                let choices = try XCTUnwrap(provider.submenu)
                let unavailable = try XCTUnwrap(choices.items.first { $0.title.hasPrefix("Locked fixture") })
                XCTAssertFalse(unavailable.isEnabled, "The catalog requires sign-in before this model can be selected")
                XCTAssertTrue(unavailable.title.contains("Sign-in needed"))
                let unknown = try XCTUnwrap(choices.items.first { $0.title.hasPrefix("Unknown fixture") })
                XCTAssertTrue(unknown.isEnabled, "Missing availability must not refuse a model")
                let reasoningHeader = try XCTUnwrap(menu.items.firstIndex { $0.title == "Reasoning" })
                XCTAssertEqual(
                    menu.items.dropFirst(reasoningHeader + 1).prefix { $0.submenu == nil }.map(\.title),
                    ["Auto", "Brief", "Thorough"],
                    "The picker must use catalog choices, without inferring levels from the model name")
                let allowed = try XCTUnwrap(choices.items.firstIndex { $0.title.hasPrefix("Allowed fixture") })
                XCTAssertTrue(choices.items[allowed].isEnabled)
                choices.performActionForItem(at: allowed)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertEqual(model.selectedModelSelectionID, "fixture/allowed")
            XCTAssertEqual(model.displayedModelSelectionID, "fixture/allowed")

            try self.press(button) { menu in
                try Self.record(menu: menu, content: content, name: "selected")
                let provider = try XCTUnwrap(menu.items.first { $0.submenu != nil })
                let selected = try XCTUnwrap(provider.submenu?.items.first {
                    $0.title.hasPrefix("Allowed fixture")
                })
                XCTAssertEqual(selected.state, .on)
                let thorough = try XCTUnwrap(menu.items.firstIndex { $0.title == "Thorough" })
                menu.performActionForItem(at: thorough)
            }
            XCTAssertEqual(model.selectedThinkingLevel, "high")
            XCTAssertTrue(model.modelControlLabel.contains("Thorough"))
            try self.press(button) { menu in
                try Self.record(menu: menu, content: content, name: "effort")
                let speed = try XCTUnwrap(menu.items.first { $0.title == "Speed" }?.submenu)
                XCTAssertEqual(speed.items.map(\.title), ["Session default", "Fast", "Normal"])
                XCTAssertTrue(speed.items.allSatisfy(\.isEnabled))
                XCTAssertEqual(speed.items[0].state, .on)
                speed.performActionForItem(at: 1)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertTrue(model.speed.isEnabled)
            XCTAssertEqual(model.speed.override, .on)
            XCTAssertTrue(model.modelControlLabel.contains("Fast"))
            try self.press(button) { menu in
                try Self.record(menu: menu, content: content, name: "fast")
                let speed = try XCTUnwrap(menu.items.first { $0.title == "Speed" }?.submenu)
                XCTAssertEqual(speed.items[1].state, .on)
                speed.performActionForItem(at: 0)
            }
            try await self.waitForModel { !model.isUpdatingModel }
            XCTAssertNil(model.speed.override)
            XCTAssertFalse(model.speed.isEnabled)
            XCTAssertEqual(model.selectedThinkingLevel, "high")
            try self.press(button) { menu in
                try Self.record(menu: menu, content: content, name: "inherited")
                let speed = try XCTUnwrap(menu.items.first { $0.title == "Speed" }?.submenu)
                XCTAssertEqual(speed.items.map(\.state), [.on, .off, .off])
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

    private func waitForModel(_ condition: @escaping @MainActor () -> Bool) async throws {
        let ready = XCTestExpectation(description: "Quick Chat model state settled")
        let observation = QuickChatCatalogObservation(condition: condition, ready: ready)
        observation.observe()
        let result = await XCTWaiter.fulfillment(of: [ready], timeout: 5)
        observation.stop()
        XCTAssertEqual(result, .completed)
        XCTAssertTrue(condition())
    }

    private func press(_ button: AnyObject, inspect: @escaping (NSMenu) throws -> Void) throws {
        let tracking = QuickChatCatalogMenuTracking(inspect: inspect)
        tracking.start()
        defer { tracking.stop() }
        XCTAssertTrue(button.accessibilityPerformPress?() == true)
        XCTAssertTrue(tracking.observed, "Pressing the rendered control must open its native menu")
        XCTAssertFalse(tracking.timedOut, "The menu must finish before its tracking deadline")
        if let error = tracking.error { throw error }
    }

    private static func record(menu: NSMenu, content: NSView, name: String) throws {
        func items(_ menu: NSMenu) -> [[String: Any]] {
            menu.items.map { item in
                var row: [String: Any] = [
                    "title": item.title, "enabled": item.isEnabled, "selected": item.state == .on,
                ]
                if let submenu = item.submenu { row["children"] = items(submenu) }
                return row
            }
        }
        let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("quick-chat-proof", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: items(menu), options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("\(name)-menu.json"))
        let image = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: image)
        try XCTUnwrap(image.representation(using: .png, properties: [:]))
            .write(to: output.appendingPathComponent("\(name)-window.png"))
        if CGPreflightScreenCaptureAccess(),
           let windows = CGWindowListCopyWindowInfo(
               [.optionOnScreenOnly, .excludeDesktopElements],
               0) as? [[String: Any]]
        {
            for window in windows
                where window[kCGWindowOwnerPID as String] as? Int32 == ProcessInfo.processInfo.processIdentifier
            {
                guard window[kCGWindowLayer as String] as? Int == NSWindow.Level.popUpMenu.rawValue,
                      let number = window[kCGWindowNumber as String] as? UInt32 else { continue }
                let capture = Process()
                capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                capture.arguments = [
                    "-x",
                    "-l",
                    String(number),
                    output.appendingPathComponent("\(name)-menu-\(number).png").path,
                ]
                try capture.run()
                capture.waitUntilExit()
                XCTAssertEqual(capture.terminationStatus, 0)
            }
        }
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
            payload = #"{"defaultId":"main","mainKey":"main","scope":"per-agent","agents":[{"id":"main","kind":"agent","name":"Fixture"}]}"#
        case "models.list":
            let params = try XCTUnwrap(request["params"] as? [String: Any])
            XCTAssertEqual(params["sessionKey"] as? String, "agent:main:main")
            payload = """
            {"models":[
              {"id":"current","name":"Current fixture","provider":"fixture","available":true,
               "thinkingLevels":[{"id":"low","label":"Brief"},{"id":"high","label":"Thorough"}],
               "thinkingDefault":"low","supportsFastMode":true,"effectiveFastMode":false},
              {"id":"allowed","name":"Allowed fixture","provider":"fixture","available":true,
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

@MainActor
private final class QuickChatCatalogMenuTracking: NSObject {
    let inspect: (NSMenu) throws -> Void
    private(set) var observed = false
    private(set) var timedOut = false
    private(set) var error: Error?
    private var menu: NSMenu?
    private var inspection: Timer?
    private var deadline: Timer?

    init(inspect: @escaping (NSMenu) throws -> Void) {
        self.inspect = inspect
    }

    func start() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(self.beganTracking(_:)),
            name: NSMenu.didBeginTrackingNotification, object: nil)
    }

    @objc private func beganTracking(_ notification: Notification) {
        guard !self.observed, let menu = notification.object as? NSMenu else { return }
        self.observed = true
        self.menu = menu
        // AppKit tracks menus in a nested run loop. Schedule both inspection and cancellation there.
        let inspection = Timer(
            timeInterval: 0,
            target: self,
            selector: #selector(self.inspectMenu),
            userInfo: nil,
            repeats: false)
        let deadline = Timer(
            timeInterval: 3,
            target: self,
            selector: #selector(self.expire),
            userInfo: nil,
            repeats: false)
        self.inspection = inspection
        self.deadline = deadline
        for timer in [inspection, deadline] {
            RunLoop.main.add(timer, forMode: .eventTracking)
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    @objc private func inspectMenu() {
        guard let menu = self.menu else { return }
        defer { menu.cancelTrackingWithoutAnimation() }
        do { try self.inspect(menu) } catch { self.error = error }
    }

    @objc private func expire() {
        self.timedOut = true
        self.menu?.cancelTrackingWithoutAnimation()
    }

    func stop() {
        self.inspection?.invalidate()
        self.deadline?.invalidate()
        self.menu?.cancelTrackingWithoutAnimation()
        NotificationCenter.default.removeObserver(self)
    }
}
