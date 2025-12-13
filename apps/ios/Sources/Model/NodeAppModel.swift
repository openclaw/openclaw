import ClawdisKit
import Network
import SwiftUI

@MainActor
final class NodeAppModel: ObservableObject {
    @Published var isBackgrounded: Bool = false
    let screen = ScreenController()
    @Published var bridgeStatusText: String = "Not connected"
    @Published var bridgeServerName: String?
    @Published var bridgeRemoteAddress: String?
    @Published var connectedBridgeID: String?

    private let bridge = BridgeSession()
    private var bridgeTask: Task<Void, Never>?
    let voiceWake = VoiceWakeManager()

    init() {
        self.voiceWake.configure { [weak self] cmd in
            guard let self else { return }
            let nodeId = UserDefaults.standard.string(forKey: "node.instanceId") ?? "ios-node"
            let sessionKey = "node-\(nodeId)"
            do {
                try await self.sendVoiceTranscript(text: cmd, sessionKey: sessionKey)
            } catch {
                // Best-effort only.
            }
        }

        let enabled = UserDefaults.standard.bool(forKey: "voiceWake.enabled")
        self.voiceWake.setEnabled(enabled)
    }

    func setScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            self.isBackgrounded = true
        case .active, .inactive:
            self.isBackgrounded = false
        @unknown default:
            self.isBackgrounded = false
        }
    }

    func setVoiceWakeEnabled(_ enabled: Bool) {
        self.voiceWake.setEnabled(enabled)
    }

    func connectToBridge(
        endpoint: NWEndpoint,
        token: String,
        nodeId: String,
        displayName: String?,
        platform: String,
        version: String)
    {
        self.bridgeTask?.cancel()
        self.bridgeStatusText = "Connecting…"
        self.bridgeServerName = nil
        self.bridgeRemoteAddress = nil
        self.connectedBridgeID = BridgeEndpointID.stableID(endpoint)

        self.bridgeTask = Task {
            do {
                try await self.bridge.connect(
                    endpoint: endpoint,
                    hello: BridgeHello(
                        nodeId: nodeId,
                        displayName: displayName,
                        token: token,
                        platform: platform,
                        version: version),
                    onConnected: { [weak self] serverName in
                        guard let self else { return }
                        await MainActor.run {
                            self.bridgeStatusText = "Connected"
                            self.bridgeServerName = serverName
                        }
                        if let addr = await self.bridge.currentRemoteAddress() {
                            await MainActor.run {
                                self.bridgeRemoteAddress = addr
                            }
                        }
                    },
                    onInvoke: { [weak self] req in
                        guard let self else {
                            return BridgeInvokeResponse(
                                id: req.id,
                                ok: false,
                                error: ClawdisNodeError(code: .unavailable, message: "UNAVAILABLE: node not ready"))
                        }
                        return await self.handleInvoke(req)
                    })

                await MainActor.run {
                    self.bridgeStatusText = "Disconnected"
                    self.bridgeServerName = nil
                    self.bridgeRemoteAddress = nil
                    self.connectedBridgeID = nil
                }
            } catch {
                await MainActor.run {
                    self.bridgeStatusText = "Bridge error: \(error.localizedDescription)"
                    self.bridgeServerName = nil
                    self.bridgeRemoteAddress = nil
                    self.connectedBridgeID = nil
                }
            }
        }
    }

    func disconnectBridge() {
        self.bridgeTask?.cancel()
        self.bridgeTask = nil
        Task { await self.bridge.disconnect() }
        self.bridgeStatusText = "Disconnected"
        self.bridgeServerName = nil
        self.bridgeRemoteAddress = nil
        self.connectedBridgeID = nil
    }

    func sendVoiceTranscript(text: String, sessionKey: String?) async throws {
        struct Payload: Codable {
            var text: String
            var sessionKey: String?
        }
        let payload = Payload(text: text, sessionKey: sessionKey)
        let data = try JSONEncoder().encode(payload)
        let json = String(decoding: data, as: UTF8.self)
        try await self.bridge.sendEvent(event: "voice.transcript", payloadJSON: json)
    }

    func handleDeepLink(url: URL) async {
        guard let route = DeepLinkParser.parse(url) else { return }

        switch route {
        case let .agent(link):
            await self.handleAgentDeepLink(link, originalURL: url)
        }
    }

    private func handleAgentDeepLink(_ link: AgentDeepLink, originalURL: URL) async {
        let message = link.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }

        if message.count > 20000 {
            self.screen.errorText = "Deep link too large (message exceeds 20,000 characters)."
            return
        }

        guard await self.isBridgeConnected() else {
            self.screen.errorText = "Bridge not connected (cannot forward deep link)."
            return
        }

        do {
            try await self.sendAgentRequest(link: link)
            self.screen.errorText = nil
        } catch {
            self.screen.errorText = "Agent request failed: \(error.localizedDescription)"
        }
    }

    private func sendAgentRequest(link: AgentDeepLink) async throws {
        if link.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NSError(domain: "DeepLink", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "invalid agent message",
            ])
        }

        // iOS bridge forwards to the gateway; no local auth prompts here.
        // (Key-based unattended auth is handled on macOS for clawdis:// links.)
        let data = try JSONEncoder().encode(link)
        let json = String(decoding: data, as: UTF8.self)
        try await self.bridge.sendEvent(event: "agent.request", payloadJSON: json)
    }

    private func isBridgeConnected() async -> Bool {
        if case .connected = await self.bridge.state { return true }
        return false
    }

    private func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        if req.command.hasPrefix("screen."), self.isBackgrounded {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdisNodeError(
                    code: .backgroundUnavailable,
                    message: "NODE_BACKGROUND_UNAVAILABLE: screen commands require foreground"))
        }

        do {
            switch req.command {
            case ClawdisScreenCommand.show.rawValue:
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisScreenCommand.hide.rawValue:
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisScreenCommand.setMode.rawValue:
                let params = try Self.decodeParams(ClawdisScreenSetModeParams.self, from: req.paramsJSON)
                self.screen.setMode(params.mode)
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisScreenCommand.navigate.rawValue:
                let params = try Self.decodeParams(ClawdisScreenNavigateParams.self, from: req.paramsJSON)
                self.screen.navigate(to: params.url)
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisScreenCommand.evalJS.rawValue:
                let params = try Self.decodeParams(ClawdisScreenEvalParams.self, from: req.paramsJSON)
                let result = try await self.screen.eval(javaScript: params.javaScript)
                let payload = try Self.encodePayload(["result": result])
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisScreenCommand.snapshot.rawValue:
                let params = try? Self.decodeParams(ClawdisScreenSnapshotParams.self, from: req.paramsJSON)
                let maxWidth = params?.maxWidth.map { CGFloat($0) }
                let base64 = try await self.screen.snapshotPNGBase64(maxWidth: maxWidth)
                let payload = try Self.encodePayload(["format": "png", "base64": base64])
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            default:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: ClawdisNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
            }
        } catch {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdisNodeError(code: .unavailable, message: error.localizedDescription))
        }
    }

    private static func decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        guard let json, let data = json.data(using: .utf8) else {
            throw NSError(domain: "Bridge", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(type, from: data)
    }

    private static func encodePayload(_ obj: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(obj)
        return String(decoding: data, as: UTF8.self)
    }
}
