import OpenClawKit
import Observation
import SwiftUI
import UIKit
import UserNotifications

// Wrap errors without pulling non-Sendable types into async notification paths.
private struct NotificationCallError: Error, Sendable {
    let message: String
}

// Ensures notification requests return promptly even if the system prompt blocks.
private final class NotificationInvokeLatch<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Result<T, NotificationCallError>, Never>?
    private var resumed = false

    func setContinuation(_ continuation: CheckedContinuation<Result<T, NotificationCallError>, Never>) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.continuation = continuation
    }

    func resume(_ response: Result<T, NotificationCallError>) {
        let cont: CheckedContinuation<Result<T, NotificationCallError>, Never>?
        self.lock.lock()
        if self.resumed {
            self.lock.unlock()
            return
        }
        self.resumed = true
        cont = self.continuation
        self.continuation = nil
        self.lock.unlock()
        cont?.resume(returning: response)
    }
}

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
    let screen: ScreenController
    private let camera: any CameraServicing
    private let screenRecorder: any ScreenRecordingServicing
    var gatewayStatusText: String = "Offline"
    var gatewayServerName: String?
    var gatewayRemoteAddress: String?
    var connectedGatewayID: String?
    var seamColorHex: String?
    var mainSessionKey: String = "main"

    private let gateway = GatewayNodeSession()
    private var gatewayTask: Task<Void, Never>?
    private var voiceWakeSyncTask: Task<Void, Never>?
    @ObservationIgnored private var cameraHUDDismissTask: Task<Void, Never>?
    private let notificationCenter: NotificationCentering
    let voiceWake = VoiceWakeManager()
    let talkMode: TalkModeManager
    private let locationService: any LocationServicing
    private let deviceStatusService: any DeviceStatusServicing
    private let photosService: any PhotosServicing
    private let contactsService: any ContactsServicing
    private let calendarService: any CalendarServicing
    private let remindersService: any RemindersServicing
    private let motionService: any MotionServicing
    private var lastAutoA2uiURL: String?
    private var pttVoiceWakeSuspended = false

    private var gatewayConnected = false
    var gatewaySession: GatewayNodeSession { self.gateway }

    var cameraHUDText: String?
    var cameraHUDKind: CameraHUDKind?
    var cameraFlashNonce: Int = 0
    var screenRecordActive: Bool = false

    init(
        screen: ScreenController = ScreenController(),
        camera: any CameraServicing = CameraController(),
        screenRecorder: any ScreenRecordingServicing = ScreenRecordService(),
        locationService: any LocationServicing = LocationService(),
        notificationCenter: NotificationCentering = LiveNotificationCenter(),
        deviceStatusService: any DeviceStatusServicing = DeviceStatusService(),
        photosService: any PhotosServicing = PhotoLibraryService(),
        contactsService: any ContactsServicing = ContactsService(),
        calendarService: any CalendarServicing = CalendarService(),
        remindersService: any RemindersServicing = RemindersService(),
        motionService: any MotionServicing = MotionService(),
        talkMode: TalkModeManager = TalkModeManager())
    {
        self.screen = screen
        self.camera = camera
        self.screenRecorder = screenRecorder
        self.locationService = locationService
        self.notificationCenter = notificationCenter
        self.deviceStatusService = deviceStatusService
        self.photosService = photosService
        self.contactsService = contactsService
        self.calendarService = calendarService
        self.remindersService = remindersService
        self.motionService = motionService
        self.talkMode = talkMode

        self.voiceWake.configure { [weak self] cmd in
            guard let self else { return }
            let sessionKey = await MainActor.run { self.mainSessionKey }
            do {
                try await self.sendVoiceTranscript(text: cmd, sessionKey: sessionKey)
            } catch {
                // Best-effort only.
            }
        }

        let enabled = UserDefaults.standard.bool(forKey: "voiceWake.enabled")
        self.voiceWake.setEnabled(enabled)
        self.talkMode.attachGateway(self.gateway)
        let talkEnabled = UserDefaults.standard.bool(forKey: "talk.enabled")
        self.talkMode.setEnabled(talkEnabled)

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

        guard let name = OpenClawCanvasA2UIAction.extractActionName(userAction) else { return }
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

        let host = NodeDisplayName.resolve(
            existing: UserDefaults.standard.string(forKey: "node.displayName"),
            deviceName: UIDevice.current.name,
            interfaceIdiom: UIDevice.current.userInterfaceIdiom)
        let instanceId = (UserDefaults.standard.string(forKey: "node.instanceId") ?? "ios-node").lowercased()
        let contextJSON = OpenClawCanvasA2UIAction.compactJSON(userAction["context"])
        let sessionKey = self.mainSessionKey

        let messageContext = OpenClawCanvasA2UIAction.AgentMessageContext(
            actionName: name,
            session: .init(key: sessionKey, surfaceId: surfaceId),
            component: .init(id: sourceComponentId, host: host, instanceId: instanceId),
            contextJSON: contextJSON)
        let message = OpenClawCanvasA2UIAction.formatAgentMessage(messageContext)

        let ok: Bool
        var errorText: String?
        if await !self.isGatewayConnected() {
            ok = false
            errorText = "gateway not connected"
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

        let js = OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(actionId: actionId, ok: ok, error: errorText)
        do {
            _ = try await self.screen.eval(javaScript: js)
        } catch {
            // ignore
        }
    }

    private func resolveA2UIHostURL() async -> String? {
        guard let raw = await self.gateway.currentCanvasHostUrl() else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let base = URL(string: trimmed) else { return nil }
        return base.appendingPathComponent("__openclaw__/a2ui/").absoluteString + "?platform=ios"
    }

    private func showA2UIOnConnectIfNeeded() async {
        guard let a2uiUrl = await self.resolveA2UIHostURL() else { return }
        let current = self.screen.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if current.isEmpty || current == self.lastAutoA2uiURL {
            self.screen.navigate(to: a2uiUrl)
            self.lastAutoA2uiURL = a2uiUrl
        }
    }

    private func showLocalCanvasOnDisconnect() {
        self.lastAutoA2uiURL = nil
        self.screen.showDefaultCanvas()
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

    func setTalkEnabled(_ enabled: Bool) {
        self.talkMode.setEnabled(enabled)
    }

    func requestLocationPermissions(mode: OpenClawLocationMode) async -> Bool {
        guard mode != .off else { return true }
        let status = await self.locationService.ensureAuthorization(mode: mode)
        switch status {
        case .authorizedAlways:
            return true
        case .authorizedWhenInUse:
            return mode != .always
        default:
            return false
        }
    }

    func connectToGateway(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        password: String?,
        connectOptions: GatewayConnectOptions)
    {
        self.gatewayTask?.cancel()
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        let id = gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        self.connectedGatewayID = id.isEmpty ? url.absoluteString : id
        self.gatewayConnected = false
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        let sessionBox = tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0)) }

        self.gatewayTask = Task {
            var attempt = 0
            while !Task.isCancelled {
                await MainActor.run {
                    if attempt == 0 {
                        self.gatewayStatusText = "Connecting…"
                    } else {
                        self.gatewayStatusText = "Reconnecting…"
                    }
                    self.gatewayServerName = nil
                    self.gatewayRemoteAddress = nil
                }

                do {
                    try await self.gateway.connect(
                        url: url,
                        token: token,
                        password: password,
                        connectOptions: connectOptions,
                        sessionBox: sessionBox,
                        onConnected: { [weak self] in
                            guard let self else { return }
                            await MainActor.run {
                                self.gatewayStatusText = "Connected"
                                self.gatewayServerName = url.host ?? "gateway"
                                self.gatewayConnected = true
                                self.talkMode.updateGatewayConnected(true)
                            }
                            if let addr = await self.gateway.currentRemoteAddress() {
                                await MainActor.run {
                                    self.gatewayRemoteAddress = addr
                                }
                            }
                            await self.refreshBrandingFromGateway()
                            await self.startVoiceWakeSync()
                            await self.showA2UIOnConnectIfNeeded()
                        },
                        onDisconnected: { [weak self] reason in
                            guard let self else { return }
                            await MainActor.run {
                                self.gatewayStatusText = "Disconnected"
                                self.gatewayRemoteAddress = nil
                                self.gatewayConnected = false
                                self.talkMode.updateGatewayConnected(false)
                                self.showLocalCanvasOnDisconnect()
                                self.gatewayStatusText = "Disconnected: \(reason)"
                            }
                        },
                        onInvoke: { [weak self] req in
                            guard let self else {
                                return BridgeInvokeResponse(
                                    id: req.id,
                                    ok: false,
                                    error: OpenClawNodeError(
                                        code: .unavailable,
                                        message: "UNAVAILABLE: node not ready"))
                            }
                            return await self.handleInvoke(req)
                        })

                    if Task.isCancelled { break }
                    attempt = 0
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    if Task.isCancelled { break }
                    attempt += 1
                    await MainActor.run {
                        self.gatewayStatusText = "Gateway error: \(error.localizedDescription)"
                        self.gatewayServerName = nil
                        self.gatewayRemoteAddress = nil
                        self.gatewayConnected = false
                        self.talkMode.updateGatewayConnected(false)
                        self.showLocalCanvasOnDisconnect()
                    }
                    let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                    try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
                }
            }

            await MainActor.run {
                self.gatewayStatusText = "Offline"
                self.gatewayServerName = nil
                self.gatewayRemoteAddress = nil
                self.connectedGatewayID = nil
                self.gatewayConnected = false
                self.talkMode.updateGatewayConnected(false)
                self.seamColorHex = nil
                if !SessionKey.isCanonicalMainSessionKey(self.mainSessionKey) {
                    self.mainSessionKey = "main"
                    self.talkMode.updateMainSessionKey(self.mainSessionKey)
                }
                self.showLocalCanvasOnDisconnect()
            }
        }
    }

    func disconnectGateway() {
        self.gatewayTask?.cancel()
        self.gatewayTask = nil
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        Task { await self.gateway.disconnect() }
        self.gatewayStatusText = "Offline"
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = nil
        self.gatewayConnected = false
        self.talkMode.updateGatewayConnected(false)
        self.seamColorHex = nil
        if !SessionKey.isCanonicalMainSessionKey(self.mainSessionKey) {
            self.mainSessionKey = "main"
            self.talkMode.updateMainSessionKey(self.mainSessionKey)
        }
        self.showLocalCanvasOnDisconnect()
    }

    private func applyMainSessionKey(_ key: String?) {
        let trimmed = (key ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let current = self.mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if SessionKey.isCanonicalMainSessionKey(current) { return }
        if trimmed == current { return }
        self.mainSessionKey = trimmed
        self.talkMode.updateMainSessionKey(trimmed)
    }

    var seamColor: Color {
        Self.color(fromHex: self.seamColorHex) ?? Self.defaultSeamColor
    }

    private static let defaultSeamColor = Color(red: 79 / 255.0, green: 122 / 255.0, blue: 154 / 255.0)

    private static func color(fromHex raw: String?) -> Color? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hex = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }

    private func refreshBrandingFromGateway() async {
        do {
            let res = try await self.gateway.request(method: "config.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let ui = config["ui"] as? [String: Any]
            let raw = (ui?["seamColor"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let session = config["session"] as? [String: Any]
            let mainKey = SessionKey.normalizeMainKey(session?["mainKey"] as? String)
            await MainActor.run {
                self.seamColorHex = raw.isEmpty ? nil : raw
                if !SessionKey.isCanonicalMainSessionKey(self.mainSessionKey) {
                    self.mainSessionKey = mainKey
                    self.talkMode.updateMainSessionKey(mainKey)
                }
            }
        } catch {
            // ignore
        }
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
            _ = try await self.gateway.request(method: "voicewake.set", paramsJSON: json, timeoutSeconds: 12)
        } catch {
            // Best-effort only.
        }
    }

    private func startVoiceWakeSync() async {
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = Task { [weak self] in
            guard let self else { return }

            await self.refreshWakeWordsFromGateway()

            let stream = await self.gateway.subscribeServerEvents(bufferingNewest: 200)
            for await evt in stream {
                if Task.isCancelled { return }
                guard evt.event == "voicewake.changed" else { continue }
                guard let payload = evt.payload else { continue }
                struct Payload: Decodable { var triggers: [String] }
                guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: Payload.self) else { continue }
                let triggers = VoiceWakePreferences.sanitizeTriggerWords(decoded.triggers)
                VoiceWakePreferences.saveTriggerWords(triggers)
            }
        }
    }

    private func refreshWakeWordsFromGateway() async {
        do {
            let data = try await self.gateway.request(method: "voicewake.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: data) else { return }
            VoiceWakePreferences.saveTriggerWords(triggers)
        } catch {
            // Best-effort only.
        }
    }

    func sendVoiceTranscript(text: String, sessionKey: String?) async throws {
        if await !self.isGatewayConnected() {
            throw NSError(domain: "Gateway", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }
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
        await self.gateway.sendEvent(event: "voice.transcript", payloadJSON: json)
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

        guard await self.isGatewayConnected() else {
            self.screen.errorText = "Gateway not connected (cannot forward deep link)."
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

        // iOS gateway forwards to the gateway; no local auth prompts here.
        // (Key-based unattended auth is handled on macOS for openclaw:// links.)
        let data = try JSONEncoder().encode(link)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode agent request payload as UTF-8",
            ])
        }
        await self.gateway.sendEvent(event: "agent.request", payloadJSON: json)
    }

    private func isGatewayConnected() async -> Bool {
        self.gatewayConnected
    }

    private func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        let command = req.command

        if self.isBackgrounded, self.isBackgroundRestricted(command) {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .backgroundUnavailable,
                    message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground"))
        }

        if command.hasPrefix("camera."), !self.isCameraEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "CAMERA_DISABLED: enable Camera in iOS Settings → Camera → Allow Camera"))
        }

        do {
            switch command {
            case OpenClawLocationCommand.get.rawValue:
                return try await self.handleLocationInvoke(req)
            case OpenClawCanvasCommand.present.rawValue,
                 OpenClawCanvasCommand.hide.rawValue,
                 OpenClawCanvasCommand.navigate.rawValue,
                 OpenClawCanvasCommand.evalJS.rawValue,
                 OpenClawCanvasCommand.snapshot.rawValue:
                return try await self.handleCanvasInvoke(req)
            case OpenClawCanvasA2UICommand.reset.rawValue,
                 OpenClawCanvasA2UICommand.push.rawValue,
                 OpenClawCanvasA2UICommand.pushJSONL.rawValue:
                return try await self.handleCanvasA2UIInvoke(req)
            case OpenClawCameraCommand.list.rawValue,
                 OpenClawCameraCommand.snap.rawValue,
                 OpenClawCameraCommand.clip.rawValue:
                return try await self.handleCameraInvoke(req)
            case OpenClawScreenCommand.record.rawValue:
                return try await self.handleScreenRecordInvoke(req)
            case OpenClawSystemCommand.notify.rawValue:
                return try await self.handleSystemNotify(req)
            case OpenClawDeviceCommand.status.rawValue,
                 OpenClawDeviceCommand.info.rawValue:
                return try await self.handleDeviceInvoke(req)
            case OpenClawPhotosCommand.latest.rawValue:
                return try await self.handlePhotosInvoke(req)
            case OpenClawContactsCommand.search.rawValue,
                 OpenClawContactsCommand.add.rawValue:
                return try await self.handleContactsInvoke(req)
            case OpenClawCalendarCommand.events.rawValue,
                 OpenClawCalendarCommand.add.rawValue:
                return try await self.handleCalendarInvoke(req)
            case OpenClawRemindersCommand.list.rawValue,
                 OpenClawRemindersCommand.add.rawValue:
                return try await self.handleRemindersInvoke(req)
            case OpenClawMotionCommand.activity.rawValue,
                 OpenClawMotionCommand.pedometer.rawValue:
                return try await self.handleMotionInvoke(req)
            case OpenClawTalkCommand.pttStart.rawValue,
                 OpenClawTalkCommand.pttStop.rawValue:
                return try await self.handleTalkInvoke(req)
            default:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
            }
        } catch {
            if command.hasPrefix("camera.") {
                let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.showCameraHUD(text: text, kind: .error, autoHideSeconds: 2.2)
            }
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: error.localizedDescription))
        }
    }

    private func isBackgroundRestricted(_ command: String) -> Bool {
        command.hasPrefix("canvas.") || command.hasPrefix("camera.") || command.hasPrefix("screen.") ||
            command.hasPrefix("talk.")
    }

    private func handleLocationInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let mode = self.locationMode()
        guard mode != .off else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_DISABLED: enable Location in Settings"))
        }
        if self.isBackgrounded, mode != .always {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .backgroundUnavailable,
                    message: "LOCATION_BACKGROUND_UNAVAILABLE: background location requires Always"))
        }
        let params = (try? Self.decodeParams(OpenClawLocationGetParams.self, from: req.paramsJSON)) ??
            OpenClawLocationGetParams()
        let desired = params.desiredAccuracy ??
            (self.isLocationPreciseEnabled() ? .precise : .balanced)
        let status = self.locationService.authorizationStatus()
        if status != .authorizedAlways, status != .authorizedWhenInUse {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: grant Location permission"))
        }
        if self.isBackgrounded, status != .authorizedAlways {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: enable Always for background access"))
        }
        let location = try await self.locationService.currentLocation(
            params: params,
            desiredAccuracy: desired,
            maxAgeMs: params.maxAgeMs,
            timeoutMs: params.timeoutMs)
        let isPrecise = self.locationService.accuracyAuthorization() == .fullAccuracy
        let payload = OpenClawLocationPayload(
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy,
            altitudeMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
            speedMps: location.speed >= 0 ? location.speed : nil,
            headingDeg: location.course >= 0 ? location.course : nil,
            timestamp: ISO8601DateFormatter().string(from: location.timestamp),
            isPrecise: isPrecise,
            source: nil)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleCanvasInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCanvasCommand.present.rawValue:
            // iOS ignores placement hints; canvas always fills the screen.
            let params = (try? Self.decodeParams(OpenClawCanvasPresentParams.self, from: req.paramsJSON)) ??
                OpenClawCanvasPresentParams()
            let url = params.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if url.isEmpty {
                self.screen.showDefaultCanvas()
            } else {
                self.screen.navigate(to: url)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.hide.rawValue:
            self.screen.showDefaultCanvas()
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.navigate.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasNavigateParams.self, from: req.paramsJSON)
            self.screen.navigate(to: params.url)
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.evalJS.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasEvalParams.self, from: req.paramsJSON)
            let result = try await self.screen.eval(javaScript: params.javaScript)
            let payload = try Self.encodePayload(["result": result])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCanvasCommand.snapshot.rawValue:
            let params = try? Self.decodeParams(OpenClawCanvasSnapshotParams.self, from: req.paramsJSON)
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
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCanvasA2UIInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let command = req.command
        switch command {
        case OpenClawCanvasA2UICommand.reset.rawValue:
            guard let a2uiUrl = await self.resolveA2UIHostURL() else {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host"))
            }
            self.screen.navigate(to: a2uiUrl)
            if await !self.screen.waitForA2UIReady(timeoutMs: 5000) {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable"))
            }

            let json = try await self.screen.eval(javaScript: """
            (() => {
              const host = globalThis.openclawA2UI;
              if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
              return JSON.stringify(host.reset());
            })()
            """)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawCanvasA2UICommand.push.rawValue, OpenClawCanvasA2UICommand.pushJSONL.rawValue:
            let messages: [AnyCodable]
            if command == OpenClawCanvasA2UICommand.pushJSONL.rawValue {
                let params = try Self.decodeParams(OpenClawCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                messages = try OpenClawCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
            } else {
                do {
                    let params = try Self.decodeParams(OpenClawCanvasA2UIPushParams.self, from: req.paramsJSON)
                    messages = params.messages
                } catch {
                    // Be forgiving: some clients still send JSONL payloads to `canvas.a2ui.push`.
                    let params = try Self.decodeParams(OpenClawCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                    messages = try OpenClawCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
                }
            }

            guard let a2uiUrl = await self.resolveA2UIHostURL() else {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host"))
            }
            self.screen.navigate(to: a2uiUrl)
            if await !self.screen.waitForA2UIReady(timeoutMs: 5000) {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable"))
            }

            let messagesJSON = try OpenClawCanvasA2UIJSONL.encodeMessagesJSONArray(messages)
            let js = """
            (() => {
              try {
                const host = globalThis.openclawA2UI;
                if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
                const messages = \(messagesJSON);
                return JSON.stringify(host.applyMessages(messages));
              } catch (e) {
                return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
              }
            })()
            """
            let resultJSON = try await self.screen.eval(javaScript: js)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: resultJSON)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCameraInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCameraCommand.list.rawValue:
            let devices = await self.camera.listDevices()
            struct Payload: Codable {
                var devices: [CameraController.CameraDeviceInfo]
            }
            let payload = try Self.encodePayload(Payload(devices: devices))
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.snap.rawValue:
            self.showCameraHUD(text: "Taking photo…", kind: .photo)
            self.triggerCameraFlash()
            let params = (try? Self.decodeParams(OpenClawCameraSnapParams.self, from: req.paramsJSON)) ??
                OpenClawCameraSnapParams()
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
        case OpenClawCameraCommand.clip.rawValue:
            let params = (try? Self.decodeParams(OpenClawCameraClipParams.self, from: req.paramsJSON)) ??
                OpenClawCameraClipParams()

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
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleScreenRecordInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = (try? Self.decodeParams(OpenClawScreenRecordParams.self, from: req.paramsJSON)) ??
            OpenClawScreenRecordParams()
        if let format = params.format, format.lowercased() != "mp4" {
            throw NSError(domain: "Screen", code: 30, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: screen format must be mp4",
            ])
        }
        // Status pill mirrors screen recording state so it stays visible without overlay stacking.
        self.screenRecordActive = true
        defer { self.screenRecordActive = false }
        let path = try await self.screenRecorder.record(
            screenIndex: params.screenIndex,
            durationMs: params.durationMs,
            fps: params.fps,
            includeAudio: params.includeAudio,
            outPath: nil)
        defer { try? FileManager().removeItem(atPath: path) }
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
    }

    private func handleSystemNotify(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(OpenClawSystemNotifyParams.self, from: req.paramsJSON)
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty, body.isEmpty {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: empty notification"))
        }

        let finalStatus = await self.requestNotificationAuthorizationIfNeeded()
        guard finalStatus == .authorized || finalStatus == .provisional || finalStatus == .ephemeral else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "NOT_AUTHORIZED: notifications"))
        }

        let addResult = await self.runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            let request = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil)
            try await notificationCenter.add(request)
        }
        if case let .failure(error) = addResult {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "NOTIFICATION_FAILED: \(error.message)"))
        }
        return BridgeInvokeResponse(id: req.id, ok: true)
    }

    private func requestNotificationAuthorizationIfNeeded() async -> NotificationAuthorizationStatus {
        let status = await self.notificationAuthorizationStatus()
        guard status == .notDetermined else { return status }

        // Avoid hanging invoke requests if the permission prompt is never answered.
        _ = await self.runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
            _ = try await notificationCenter.requestAuthorization(options: [.alert, .sound, .badge])
        }

        return await self.notificationAuthorizationStatus()
    }

    private func notificationAuthorizationStatus() async -> NotificationAuthorizationStatus {
        let result = await self.runNotificationCall(timeoutSeconds: 1.5) { [notificationCenter] in
            await notificationCenter.authorizationStatus()
        }
        switch result {
        case let .success(status):
            return status
        case .failure:
            return .denied
        }
    }

    private func runNotificationCall<T: Sendable>(
        timeoutSeconds: Double,
        operation: @escaping @Sendable () async throws -> T
    ) async -> Result<T, NotificationCallError> {
        let latch = NotificationInvokeLatch<T>()
        var opTask: Task<Void, Never>?
        var timeoutTask: Task<Void, Never>?
        defer {
            opTask?.cancel()
            timeoutTask?.cancel()
        }
        let clamped = max(0.0, timeoutSeconds)
        return await withCheckedContinuation { (cont: CheckedContinuation<Result<T, NotificationCallError>, Never>) in
            latch.setContinuation(cont)
            opTask = Task { @MainActor in
                do {
                    let value = try await operation()
                    latch.resume(.success(value))
                } catch {
                    latch.resume(.failure(NotificationCallError(message: error.localizedDescription)))
                }
            }
            timeoutTask = Task.detached {
                if clamped > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(clamped * 1_000_000_000))
                }
                latch.resume(.failure(NotificationCallError(message: "notification request timed out")))
            }
        }
    }

    private func handleDeviceInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawDeviceCommand.status.rawValue:
            let payload = try await self.deviceStatusService.status()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawDeviceCommand.info.rawValue:
            let payload = self.deviceStatusService.info()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handlePhotosInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = (try? Self.decodeParams(OpenClawPhotosLatestParams.self, from: req.paramsJSON)) ??
            OpenClawPhotosLatestParams()
        let payload = try await self.photosService.latest(params: params)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleContactsInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawContactsCommand.search.rawValue:
            let params = (try? Self.decodeParams(OpenClawContactsSearchParams.self, from: req.paramsJSON)) ??
                OpenClawContactsSearchParams()
            let payload = try await self.contactsService.search(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawContactsCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawContactsAddParams.self, from: req.paramsJSON)
            let payload = try await self.contactsService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCalendarInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCalendarCommand.events.rawValue:
            let params = (try? Self.decodeParams(OpenClawCalendarEventsParams.self, from: req.paramsJSON)) ??
                OpenClawCalendarEventsParams()
            let payload = try await self.calendarService.events(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawCalendarCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawCalendarAddParams.self, from: req.paramsJSON)
            let payload = try await self.calendarService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleRemindersInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawRemindersCommand.list.rawValue:
            let params = (try? Self.decodeParams(OpenClawRemindersListParams.self, from: req.paramsJSON)) ??
                OpenClawRemindersListParams()
            let payload = try await self.remindersService.list(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawRemindersCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawRemindersAddParams.self, from: req.paramsJSON)
            let payload = try await self.remindersService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleMotionInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawMotionCommand.activity.rawValue:
            let params = (try? Self.decodeParams(OpenClawMotionActivityParams.self, from: req.paramsJSON)) ??
                OpenClawMotionActivityParams()
            let payload = try await self.motionService.activities(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawMotionCommand.pedometer.rawValue:
            let params = (try? Self.decodeParams(OpenClawPedometerParams.self, from: req.paramsJSON)) ??
                OpenClawPedometerParams()
            let payload = try await self.motionService.pedometer(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleTalkInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawTalkCommand.pttStart.rawValue:
            self.pttVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            let payload = try await self.talkMode.beginPushToTalk()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttStop.rawValue:
            let payload = await self.talkMode.endPushToTalk()
            self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.pttVoiceWakeSuspended)
            self.pttVoiceWakeSuspended = false
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

}

private extension NodeAppModel {
    func locationMode() -> OpenClawLocationMode {
        let raw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        return OpenClawLocationMode(rawValue: raw) ?? .off
    }

    func isLocationPreciseEnabled() -> Bool {
        if UserDefaults.standard.object(forKey: "location.preciseEnabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "location.preciseEnabled")
    }

    static func decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        guard let json, let data = json.data(using: .utf8) else {
            throw NSError(domain: "Gateway", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(type, from: data)
    }

    static func encodePayload(_ obj: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(obj)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode payload as UTF-8",
            ])
        }
        return json
    }

    func isCameraEnabled() -> Bool {
        // Default-on: if the key doesn't exist yet, treat it as enabled.
        if UserDefaults.standard.object(forKey: "camera.enabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "camera.enabled")
    }

    func triggerCameraFlash() {
        self.cameraFlashNonce &+= 1
    }

    func showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
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

#if DEBUG
extension NodeAppModel {
    func _test_handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        await self.handleInvoke(req)
    }

    static func _test_decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        try self.decodeParams(type, from: json)
    }

    static func _test_encodePayload(_ obj: some Encodable) throws -> String {
        try self.encodePayload(obj)
    }

    func _test_isCameraEnabled() -> Bool {
        self.isCameraEnabled()
    }

    func _test_triggerCameraFlash() {
        self.triggerCameraFlash()
    }

    func _test_showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
        self.showCameraHUD(text: text, kind: kind, autoHideSeconds: autoHideSeconds)
    }

    func _test_handleCanvasA2UIAction(body: [String: Any]) async {
        await self.handleCanvasA2UIAction(body: body)
    }

    func _test_resolveA2UIHostURL() async -> String? {
        await self.resolveA2UIHostURL()
    }

    func _test_showLocalCanvasOnDisconnect() {
        self.showLocalCanvasOnDisconnect()
    }
}
#endif
