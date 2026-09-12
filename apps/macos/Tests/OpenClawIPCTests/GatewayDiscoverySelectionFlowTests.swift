import AppKit
import ConcurrencyExtras
import CryptoKit
import Foundation
import OpenClawDiscovery
import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

/// The saved route uses the ordinary handshake fixture; a retarget uses a real socket.
private final class DiscoverySelectionSession: WebSocketSessioning, @unchecked Sendable {
    let requests = LockIsolated<[URLRequest]>([])
    private let savedURL: URL
    private let saved: GatewayTestWebSocketSession
    private let network = URLSession(configuration: .ephemeral)

    init(savedURL: URL, saved: GatewayTestWebSocketSession) {
        self.savedURL = savedURL
        self.saved = saved
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        self.requests.withValue { $0.append(request) }
        return request.url == self.savedURL
            ? self.saved.makeWebSocketTask(request: request)
            : self.network.makeWebSocketTask(request: request)
    }

    func invalidate() {
        self.network.invalidateAndCancel()
    }
}

@Suite(.serialized)
@MainActor
struct GatewayDiscoverySelectionFlowTests {
    @Test(.timeLimit(.minutes(1)), arguments: [false, true])
    func `mounted nearby selection keeps the saved authenticated route`(copiesSavedID: Bool) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": root.appendingPathComponent("openclaw.json").path,
            "OPENCLAW_STATE_DIR": root.appendingPathComponent("state").path,
        ]) {
            var unknownRequests: [String] = []
            let unknownBytes = LockIsolated(Data())
            let unknown = try await DashboardHTTPFixture.start(
                rawResponseHandler: { request in
                    unknownRequests.append(request)
                    return Self.challengeResponse(request)
                },
                onPostResponseData: { data in unknownBytes.withValue { $0.append(data) } })
            defer { unknown.stop() }

            // Prove that this listener accepts a real upgrade and delivers a challenge before
            // relying on its silence after the click. No Gateway credential is sent by this control.
            let controlSession = URLSession(configuration: .ephemeral)
            let control = controlSession.webSocketTask(with: unknown.websocketURL())
            control.resume()
            do {
                let challenge = try await control.receive()
                let data = switch challenge {
                case let .data(data): data
                case let .string(text): Data(text.utf8)
                @unknown default: Data()
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                try #require(frame["event"] as? String == "connect.challenge")
            } catch {
                control.cancel(with: .goingAway, reason: nil)
                controlSession.invalidateAndCancel()
                throw error
            }
            control.cancel(with: .goingAway, reason: nil)
            controlSession.invalidateAndCancel()
            try await Self.waitUntil("liveness-control disconnect") { unknown.activeConnectionCount == 0 }
            try #require(unknownRequests.count == 1)
            unknownRequests.removeAll()
            unknownBytes.withValue { $0.removeAll() }

            let token = "saved-selection-fixture-token"
            let savedURL = try #require(URL(string: "ws://127.0.0.1:18789/saved-selection/"))
            try #require(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": ["transport": "direct", "url": savedURL.absoluteString, "token": token],
                ],
            ]))
            let oldID = GatewayDiscoveryPreferences.preferredStableID()
            let oldBinding = GatewayDiscoveryPreferences.preferredRouteBinding()
            GatewayDiscoveryPreferences.setPreferredStableID("saved-selection", routeBinding: "saved-selection-binding")
            defer { GatewayDiscoveryPreferences.setPreferredStableID(oldID, routeBinding: oldBinding) }
            let state = AppState(preview: true)
            let savedMethods = LockIsolated<[String]>([])
            let savedConnectTokens = LockIsolated<[String]>([])
            let savedSession = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, _ in
                    guard let method = GatewayWebSocketTestSupport.requestMethod(from: message),
                          let id = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    if method == "connect" {
                        let params = GatewayWebSocketTestSupport.connectRequestParams(from: message)
                        let auth = params?["auth"] as? [String: Any]
                        if let sentToken = auth?["token"] as? String {
                            savedConnectTokens.withValue { $0.append(sentToken) }
                        }
                        return
                    }
                    savedMethods.withValue { $0.append(method) }
                    let response: Data = if method == "agents.list" {
                        Data("""
                        {"type":"res","id":"\(id)","ok":true,"payload":{
                          "defaultId":"main","mainKey":"main","scope":"per-sender","agents":[]}}
                        """.utf8)
                    } else {
                        GatewayWebSocketTestSupport.okResponseData(id: id)
                    }
                    task.emitReceiveSuccess(.data(response))
                })
            })
            let session = DiscoverySelectionSession(savedURL: savedURL, saved: savedSession)
            defer { session.invalidate() }
            let gateway = GatewayConnection(
                configProvider: {
                    try await MainActor.run {
                        try (url: #require(URL(string: state.remoteUrl)), token: state.remoteToken, password: nil)
                    }
                },
                sessionBox: WebSocketSessionBox(session: session))
            let discovery = GatewayDiscoveryModel(localDisplayName: "Selection fixture", filterLocalGateways: false)
            var persistenceCalls = 0
            let view = OnboardingView(
                state: state,
                discoveryModel: discovery,
                aiSetupGateway: gateway,
                configuredGatewayProbeTimeoutMs: 1000,
                gatewaySelectionPersister: {
                    persistenceCalls += 1
                    return state.syncGatewayConfigNow()
                },
                dashboardHandoffOpener: { _ in Issue.record("Nearby selection must not finish onboarding") })
            let model = view.aiSetup
            let probe = view.configuredGatewayProbe
            _ = AppKitTestSupport.application
            var appeared = false
            var disappeared = false
            var didCleanup = false
            let hosting = NSHostingView(rootView: AnyView(EmptyView()))
            hosting.frame = NSRect(x: 0, y: 0, width: 630, height: 1000)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false

            @MainActor
            func cleanup() async {
                guard !didCleanup else { return }
                didCleanup = true
                probe.invalidate()
                model.resetForGatewayChange(clearPendingHandoff: false)
                if let sheet = window.attachedSheet { window.endSheet(sheet) }
                hosting.rootView = AnyView(EmptyView())
                hosting.layoutSubtreeIfNeeded()
                window.orderOut(nil)
                window.contentView = nil
                window.close()
                do {
                    try await Self.waitUntil("mounted onboarding disappearance") { !appeared || disappeared }
                } catch { Issue.record(error) }
                discovery.stop()
                await gateway.shutdown()
                session.invalidate()
            }

            do {
                hosting.rootView = AnyView(view
                    .environment(\.locale, Locale(identifier: "en_US"))
                    .onAppear { appeared = true }
                    .onDisappear { disappeared = true })
                window.contentView = hosting
                window.orderFront(nil)
                hosting.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                try await Self.waitUntil("visible saved-route authenticated probe") {
                    appeared && persistenceCalls >= 2 && savedConnectTokens.value.contains(token) &&
                        savedMethods.value.contains("agents.list")
                }
                try #require(session.requests.value.allSatisfy { $0.url == savedURL })
                try await Self.press("Next", in: hosting)
                try await Self.waitUntil("connection-page discovery start") {
                    discovery.statusText != GatewayDiscoveryStatusText.idle
                }
                // Stop only this injected discovery producer before supplying its normal public
                // projection. No delayed browse callback can overwrite the fixture during the click.
                discovery.stop()
                let name = "Nearby selection fixture"
                discovery.gateways = [.init(
                    displayName: name,
                    serviceHost: "127.0.0.1",
                    servicePort: Int(unknown.port),
                    lanHost: "127.0.0.1",
                    sshPort: 22,
                    gatewayPort: Int(unknown.port),
                    gatewayTls: false,
                    gatewayDirectReachable: true,
                    stableID: copiesSavedID ? "saved-selection" : "unknown-selection",
                    debugID: "unknown-selection",
                    isLocal: false)]
                try await Self.waitUntil("mounted Nearby button") {
                    try await Self.button(name, in: hosting) != nil
                }
                // Finish the startup probe/replayed snapshot before attributing later activity to
                // the click. This explicit read-only inspection uses the existing owner operation.
                let inspection = try #require(view.probeConfiguredGatewayForDashboard(
                    intent: .inspectOnly, knownVisible: true))
                await inspection.value
                model.manualKey = "pending-selection-fixture-key"
                let before = try Data(contentsOf: root.appendingPathComponent("openclaw.json"))
                let savedRequestCount = session.requests.value.count
                let savedMethodCount = savedMethods.value.count

                try await Self.press(name, in: hosting)
                try await Self.waitUntil("trusted-input sheet or changed saved destination") {
                    window.attachedSheet != nil || state.remoteUrl != savedURL.absoluteString
                }
                #expect(state.remoteUrl == savedURL.absoluteString)
                #expect(state.remoteTransport == .direct)
                #expect(state.remoteToken == token)
                #expect(GatewayDiscoveryPreferences.preferredStableID() == "saved-selection")
                #expect(GatewayDiscoveryPreferences.preferredRouteBinding() == "saved-selection-binding")
                #expect(model.manualKey == "pending-selection-fixture-key")
                #expect(try Data(contentsOf: root.appendingPathComponent("openclaw.json")) == before)
                #expect(unknownRequests.isEmpty)
                #expect(Self.clientObjects(unknownBytes.value).isEmpty)
                #expect(session.requests.value.count == savedRequestCount)
                #expect(savedMethods.value.count == savedMethodCount)

                let sheet = try #require(window.attachedSheet?.contentView)
                let fields = try await AppKitTestSupport.accessibilityElements(in: sheet)
                    .filter { $0.accessibilityRole?() == .textField }
                    .compactMap {
                        let value: Any? = $0.accessibilityValue?()
                        return value as? String
                    }
                #expect(!fields.contains(unknown.websocketURL().absoluteString))
                try await Self.press("Cancel", in: sheet)
                try await Self.waitUntil("trusted-input cancellation") { window.attachedSheet == nil }
                await cleanup()
                #expect(unknownRequests.isEmpty)
                #expect(Self.clientObjects(unknownBytes.value).isEmpty)
                #expect(try Data(contentsOf: root.appendingPathComponent("openclaw.json")) == before)
            } catch {
                await cleanup()
                throw error
            }
        }
    }

    private static func button(_ title: String, in root: NSView) async throws -> AnyObject? {
        let matches = try await AppKitTestSupport.accessibilityElements(in: root).filter {
            $0.accessibilityRole?() == .button && $0.isAccessibilityEnabled?() == true &&
                [$0.accessibilityLabel?(), $0.accessibilityTitle?()].compactMap(\.self).contains {
                    $0 == title || (title == "Nearby selection fixture" && $0.contains(title))
                }
        }
        try #require(matches.count <= 1, "Ambiguous mounted button: \(title)")
        return matches.first
    }

    private static func press(_ title: String, in root: NSView) async throws {
        let element = try await self.button(title, in: root)
        let button = try #require(element, "Missing mounted button: \(title)")
        try #require(button.accessibilityPerformPress?() == true)
    }

    private static func waitUntil(_ description: String, _ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(
            domain: "GatewayDiscoverySelectionFlowTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Timed out: \(description)"])
    }

    private static func challengeResponse(_ request: String) -> DashboardHTTPFixture.RawResponse? {
        guard let key = request.components(separatedBy: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("sec-websocket-key:") })?
            .split(separator: ":", maxSplits: 1).last?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        else { return nil }
        let accept = Data(Insecure.SHA1.hash(data: Data(
            "\(key)258EAFA5-E914-47DA-95CA-C5AB0DC85B11".utf8))).base64EncodedString()
        let headers = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: \(accept)\r\n\r\n"
        let challenge = Data(#"{"type":"event","event":"connect.challenge","payload":{"nonce":"selection-fixture"}}"#
            .utf8)
        precondition(challenge.count < 126)
        return .init(
            data: Data(headers.utf8) + Data([0x81, UInt8(challenge.count)]) + challenge,
            keepConnectionOpen: true)
    }

    /// Network receives can split a frame. Decode only complete bounded client data frames.
    private static func clientObjects(_ data: Data) -> [[String: Any]] {
        let bytes = [UInt8](data)
        var offset = 0
        var objects: [[String: Any]] = []
        while offset + 2 <= bytes.count {
            let opcode = bytes[offset] & 0x0F
            let masked = bytes[offset + 1] & 0x80 != 0
            var length = Int(bytes[offset + 1] & 0x7F)
            var cursor = offset + 2
            if length == 126 {
                guard cursor + 2 <= bytes.count else { break }
                length = Int(bytes[cursor]) << 8 | Int(bytes[cursor + 1])
                cursor += 2
            } else if length == 127 {
                break
            }
            let maskCount = masked ? 4 : 0
            guard cursor + maskCount + length <= bytes.count else { break }
            let mask = masked ? Array(bytes[cursor..<(cursor + 4)]) : [UInt8](repeating: 0, count: 4)
            cursor += maskCount
            let payload = Data((0..<length).map { bytes[cursor + $0] ^ mask[$0 % 4] })
            if opcode == 1 || opcode == 2,
               let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
            {
                objects.append(object)
            }
            offset = cursor + length
        }
        return objects
    }
}
