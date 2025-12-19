import ClawdisKit
import Network
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class NodeAppModel {
    enum CameraHUDKind {
        case photo
        case recording
        case success
        case error
    }

    var isBackgrounded: Bool = false
    let screen = ScreenController()
    let camera = CameraController()
    private let screenRecorder = ScreenRecordService()
    var bridgeStatusText: String = "Offline"
    var bridgeServerName: String?
    var bridgeRemoteAddress: String?
    var connectedBridgeID: String?

    private let bridge = BridgeSession()
    private var bridgeTask: Task<Void, Never>?
    private var voiceWakeSyncTask: Task<Void, Never>?
    @ObservationIgnored private var cameraHUDDismissTask: Task<Void, Never>?
    let voiceWake = VoiceWakeManager()

    var bridgeSession: BridgeSession { self.bridge }

    var cameraHUDText: String?
    var cameraHUDKind: CameraHUDKind?
    var cameraFlashNonce: Int = 0

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

        // Wire up deep links from canvas taps
        self.screen.onDeepLink = { [weak self] url in
            guard let self else { return }
            Task { @MainActor in
                await self.handleDeepLink(url: url)
            }
        }

        // Wire up A2UI action clicks (buttons, etc.)
        self.screen.onA2UIAction = { [weak self] body in
            guard let self else { return }
            Task { @MainActor in
                await self.handleCanvasA2UIAction(body: body)
            }
        }
    }

    private func handleCanvasA2UIAction(body: [String: Any]) async {
        let userActionAny = body["userAction"] ?? body
        let userAction: [String: Any] = {
            if let dict = userActionAny as? [String: Any] { return dict }
            if let dict = userActionAny as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !userAction.isEmpty else { return }

        guard let name = userAction["name"] as? String, !name.isEmpty else { return }
        let actionId: String = {
            let id = (userAction["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return id.isEmpty ? UUID().uuidString : id
        }()

        let surfaceId: String = {
            let raw = (userAction["surfaceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? "main" : raw
        }()
        let sourceComponentId: String = {
            let raw = (userAction[
                "sourceComponentId",
            ] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? "-" : raw
        }()

        let host = UserDefaults.standard.string(forKey: "node.displayName") ?? UIDevice.current.name
        let instanceId = (UserDefaults.standard.string(forKey: "node.instanceId") ?? "ios-node").lowercased()
        let contextJSON = ClawdisCanvasA2UIAction.compactJSON(userAction["context"])
        let sessionKey = "main"

        let message = ClawdisCanvasA2UIAction.formatAgentMessage(
            actionName: name,
            sessionKey: sessionKey,
            surfaceId: surfaceId,
            sourceComponentId: sourceComponentId,
            host: host,
            instanceId: instanceId,
            contextJSON: contextJSON)

        let ok: Bool
        var errorText: String? = nil
        if await !self.isBridgeConnected() {
            ok = false
            errorText = "bridge not connected"
        } else {
            do {
                try await self.sendAgentRequest(link: AgentDeepLink(
                    message: message,
                    sessionKey: sessionKey,
                    thinking: "low",
                    deliver: false,
                    to: nil,
                    channel: nil,
                    timeoutSeconds: nil,
                    key: actionId))
                ok = true
            } catch {
                ok = false
                errorText = error.localizedDescription
            }
        }

        let js = ClawdisCanvasA2UIAction.jsDispatchA2UIActionStatus(actionId: actionId, ok: ok, error: errorText)
        do {
            _ = try await self.screen.eval(javaScript: js)
        } catch {
            // ignore
        }
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
        hello: BridgeHello)
    {
        self.bridgeTask?.cancel()
        self.bridgeServerName = nil
        self.bridgeRemoteAddress = nil
        self.connectedBridgeID = BridgeEndpointID.stableID(endpoint)
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil

        self.bridgeTask = Task {
            var attempt = 0
            while !Task.isCancelled {
                await MainActor.run {
                    if attempt == 0 {
                        self.bridgeStatusText = "Connecting…"
                    } else {
                        self.bridgeStatusText = "Reconnecting…"
                    }
                    self.bridgeServerName = nil
                    self.bridgeRemoteAddress = nil
                }

                do {
                    try await self.bridge.connect(
                        endpoint: endpoint,
                        hello: hello,
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
                            await self.startVoiceWakeSync()
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

                    if Task.isCancelled { break }
                    attempt += 1
                    let sleepSeconds = min(6.0, 0.35 * pow(1.7, Double(attempt)))
                    try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
                } catch {
                    if Task.isCancelled { break }
                    attempt += 1
                    await MainActor.run {
                        self.bridgeStatusText = "Bridge error: \(error.localizedDescription)"
                        self.bridgeServerName = nil
                        self.bridgeRemoteAddress = nil
                    }
                    let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                    try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
                }
            }

            await MainActor.run {
                self.bridgeStatusText = "Offline"
                self.bridgeServerName = nil
                self.bridgeRemoteAddress = nil
                self.connectedBridgeID = nil
            }
        }
    }

    func disconnectBridge() {
        self.bridgeTask?.cancel()
        self.bridgeTask = nil
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        Task { await self.bridge.disconnect() }
        self.bridgeStatusText = "Offline"
        self.bridgeServerName = nil
        self.bridgeRemoteAddress = nil
        self.connectedBridgeID = nil
    }

    func setGlobalWakeWords(_ words: [String]) async {
        let sanitized = VoiceWakePreferences.sanitizeTriggerWords(words)

        struct Payload: Codable {
            var triggers: [String]
        }
        let payload = Payload(triggers: sanitized)
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return }

        do {
            _ = try await self.bridge.request(method: "voicewake.set", paramsJSON: json, timeoutSeconds: 12)
        } catch {
            // Best-effort only.
        }
    }

    private func startVoiceWakeSync() async {
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = Task { [weak self] in
            guard let self else { return }

            await self.refreshWakeWordsFromGateway()

            let stream = await self.bridge.subscribeServerEvents(bufferingNewest: 200)
            for await evt in stream {
                if Task.isCancelled { return }
                guard evt.event == "voicewake.changed" else { continue }
                guard let payloadJSON = evt.payloadJSON else { continue }
                guard let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: payloadJSON) else { continue }
                VoiceWakePreferences.saveTriggerWords(triggers)
            }
        }
    }

    private func refreshWakeWordsFromGateway() async {
        do {
            let data = try await self.bridge.request(method: "voicewake.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: data) else { return }
            VoiceWakePreferences.saveTriggerWords(triggers)
        } catch {
            // Best-effort only.
        }
    }

    func sendVoiceTranscript(text: String, sessionKey: String?) async throws {
        struct Payload: Codable {
            var text: String
            var sessionKey: String?
        }
        let payload = Payload(text: text, sessionKey: sessionKey)
        let data = try JSONEncoder().encode(payload)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode voice transcript payload as UTF-8",
            ])
        }
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
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode agent request payload as UTF-8",
            ])
        }
        try await self.bridge.sendEvent(event: "agent.request", payloadJSON: json)
    }

    private func isBridgeConnected() async -> Bool {
        if case .connected = await self.bridge.state { return true }
        return false
    }

    private func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        let command = req.command

        if command.hasPrefix("canvas.") || command.hasPrefix("camera.") || command.hasPrefix("screen."),
           self.isBackgrounded
        {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdisNodeError(
                    code: .backgroundUnavailable,
                    message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground"))
        }

        if command.hasPrefix("camera."), !self.isCameraEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdisNodeError(
                    code: .unavailable,
                    message: "CAMERA_DISABLED: enable Camera in iOS Settings → Camera → Allow Camera"))
        }

        do {
            switch command {
            case ClawdisCanvasCommand.present.rawValue:
                let params = (try? Self.decodeParams(ClawdisCanvasPresentParams.self, from: req.paramsJSON)) ??
                    ClawdisCanvasPresentParams()
                let url = params.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if url.isEmpty {
                    self.screen.showDefaultCanvas()
                } else {
                    self.screen.navigate(to: url)
                }
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisCanvasCommand.hide.rawValue:
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisCanvasCommand.navigate.rawValue:
                let params = try Self.decodeParams(ClawdisCanvasNavigateParams.self, from: req.paramsJSON)
                self.screen.navigate(to: params.url)
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisCanvasCommand.evalJS.rawValue:
                let params = try Self.decodeParams(ClawdisCanvasEvalParams.self, from: req.paramsJSON)
                let result = try await self.screen.eval(javaScript: params.javaScript)
                let payload = try Self.encodePayload(["result": result])
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisCanvasCommand.snapshot.rawValue:
                let params = try? Self.decodeParams(ClawdisCanvasSnapshotParams.self, from: req.paramsJSON)
                let format = params?.format ?? .jpeg
                let maxWidth: CGFloat? = {
                    if let raw = params?.maxWidth, raw > 0 { return CGFloat(raw) }
                    // Keep default snapshots comfortably below the gateway client's maxPayload.
                    // For full-res, clients should explicitly request a larger maxWidth.
                    return switch format {
                    case .png: 900
                    case .jpeg: 1600
                    }
                }()
                let base64 = try await self.screen.snapshotBase64(
                    maxWidth: maxWidth,
                    format: format,
                    quality: params?.quality)
                let payload = try Self.encodePayload([
                    "format": format == .jpeg ? "jpeg" : "png",
                    "base64": base64,
                ])
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisCanvasA2UICommand.reset.rawValue:
                self.screen.showDefaultCanvas()
                if await !self.screen.waitForA2UIReady(timeoutMs: 5000) {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(code: .unavailable, message: "A2UI not ready"))
                }

                let json = try await self.screen.eval(javaScript: """
                (() => {
                  if (!globalThis.clawdisA2UI) return JSON.stringify({ ok: false, error: "missing clawdisA2UI" });
                  return JSON.stringify(globalThis.clawdisA2UI.reset());
                })()
                """)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)

            case ClawdisCanvasA2UICommand.push.rawValue, ClawdisCanvasA2UICommand.pushJSONL.rawValue:
                let messages: [AnyCodable]
                if command == ClawdisCanvasA2UICommand.pushJSONL.rawValue {
                    let params = try Self.decodeParams(ClawdisCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                    messages = try ClawdisCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
                } else {
                    do {
                        let params = try Self.decodeParams(ClawdisCanvasA2UIPushParams.self, from: req.paramsJSON)
                        messages = params.messages
                    } catch {
                        // Be forgiving: some clients still send JSONL payloads to `canvas.a2ui.push`.
                        let params = try Self.decodeParams(ClawdisCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                        messages = try ClawdisCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
                    }
                }

                self.screen.showDefaultCanvas()
                if await !self.screen.waitForA2UIReady(timeoutMs: 5000) {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(code: .unavailable, message: "A2UI not ready"))
                }

                let messagesJSON = try ClawdisCanvasA2UIJSONL.encodeMessagesJSONArray(messages)
                let js = """
                (() => {
                  try {
                    if (!globalThis.clawdisA2UI) return JSON.stringify({ ok: false, error: "missing clawdisA2UI" });
                    const messages = \(messagesJSON);
                    return JSON.stringify(globalThis.clawdisA2UI.applyMessages(messages));
                  } catch (e) {
                    return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
                  }
                })()
                """
                let resultJSON = try await self.screen.eval(javaScript: js)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: resultJSON)

            case ClawdisCameraCommand.snap.rawValue:
                self.showCameraHUD(text: "Taking photo…", kind: .photo)
                self.triggerCameraFlash()
                let params = (try? Self.decodeParams(ClawdisCameraSnapParams.self, from: req.paramsJSON)) ??
                    ClawdisCameraSnapParams()
                let res = try await self.camera.snap(params: params)

                struct Payload: Codable {
                    var format: String
                    var base64: String
                    var width: Int
                    var height: Int
                }
                let payload = try Self.encodePayload(Payload(
                    format: res.format,
                    base64: res.base64,
                    width: res.width,
                    height: res.height))
                self.showCameraHUD(text: "Photo captured", kind: .success, autoHideSeconds: 1.6)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisCameraCommand.clip.rawValue:
                let params = (try? Self.decodeParams(ClawdisCameraClipParams.self, from: req.paramsJSON)) ??
                    ClawdisCameraClipParams()

                let suspended = (params.includeAudio ?? true) ? self.voiceWake.suspendForExternalAudioCapture() : false
                defer { self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: suspended) }

                self.showCameraHUD(text: "Recording…", kind: .recording)
                let res = try await self.camera.clip(params: params)

                struct Payload: Codable {
                    var format: String
                    var base64: String
                    var durationMs: Int
                    var hasAudio: Bool
                }
                let payload = try Self.encodePayload(Payload(
                    format: res.format,
                    base64: res.base64,
                    durationMs: res.durationMs,
                    hasAudio: res.hasAudio))
                self.showCameraHUD(text: "Clip captured", kind: .success, autoHideSeconds: 1.8)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisScreenCommand.record.rawValue:
                let params = (try? Self.decodeParams(ClawdisScreenRecordParams.self, from: req.paramsJSON)) ??
                    ClawdisScreenRecordParams()
                if let format = params.format, format.lowercased() != "mp4" {
                    throw NSError(domain: "Screen", code: 30, userInfo: [
                        NSLocalizedDescriptionKey: "INVALID_REQUEST: screen format must be mp4",
                    ])
                }
                let path = try await self.screenRecorder.record(
                    screenIndex: params.screenIndex,
                    durationMs: params.durationMs,
                    fps: params.fps,
                    includeAudio: params.includeAudio,
                    outPath: nil)
                defer { try? FileManager.default.removeItem(atPath: path) }
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                struct Payload: Codable {
                    var format: String
                    var base64: String
                    var durationMs: Int?
                    var fps: Double?
                    var screenIndex: Int?
                    var hasAudio: Bool
                }
                let payload = try Self.encodePayload(Payload(
                    format: "mp4",
                    base64: data.base64EncodedString(),
                    durationMs: params.durationMs,
                    fps: params.fps,
                    screenIndex: params.screenIndex,
                    hasAudio: params.includeAudio ?? true))
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            default:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: ClawdisNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
            }
        } catch {
            if command.hasPrefix("camera.") {
                let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.showCameraHUD(text: text, kind: .error, autoHideSeconds: 2.2)
            }
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
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode payload as UTF-8",
            ])
        }
        return json
    }

    private func isCameraEnabled() -> Bool {
        // Default-on: if the key doesn't exist yet, treat it as enabled.
        if UserDefaults.standard.object(forKey: "camera.enabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "camera.enabled")
    }

    private func triggerCameraFlash() {
        self.cameraFlashNonce &+= 1
    }

    private func showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
        self.cameraHUDDismissTask?.cancel()

        withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
            self.cameraHUDText = text
            self.cameraHUDKind = kind
        }

        guard let autoHideSeconds else { return }
        self.cameraHUDDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(autoHideSeconds * 1_000_000_000))
            withAnimation(.easeOut(duration: 0.25)) {
                self.cameraHUDText = nil
                self.cameraHUDKind = nil
            }
        }
    }
}
