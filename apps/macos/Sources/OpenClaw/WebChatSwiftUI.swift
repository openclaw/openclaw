import AppKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
import QuartzCore
import SwiftUI

private let webChatSwiftLogger = Logger(subsystem: "ai.openclaw", category: "WebChatSwiftUI")
private let webChatThinkingLevelDefaultsKey = "openclaw.webchat.thinkingLevel"

private enum WebChatSwiftUILayout {
    static let windowSize = NSSize(width: 500, height: 840)
    static let panelSize = NSSize(width: 480, height: 640)
    static let windowMinSize = NSSize(width: 480, height: 360)
    static let anchorPadding: CGFloat = 8
}

struct MacGatewayChatTransport: OpenClawChatTransport {
    private let outboxGatewayID: String?

    init(outboxGatewayID: String? = nil) {
        self.outboxGatewayID = outboxGatewayID
    }

    var outboxRequiresSessionRoutingContract: Bool {
        true
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await GatewayConnection.shared.chatHistory(sessionKey: sessionKey)
    }

    func listModels() async throws -> [OpenClawChatModelChoice] {
        do {
            let data = try await GatewayConnection.shared.request(
                method: "models.list",
                params: [:],
                timeoutMs: 15000)
            let result = try JSONDecoder().decode(ModelsListResult.self, from: data)
            return result.models.map(Self.mapModelChoice)
        } catch {
            webChatSwiftLogger.warning(
                "models.list failed; hiding model picker: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        _ = try await GatewayConnection.shared.request(
            method: "chat.abort",
            params: [
                "sessionKey": AnyCodable(sessionKey),
                "runId": AnyCodable(runId),
            ],
            timeoutMs: 10000)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        var params: [String: AnyCodable] = [
            "includeGlobal": AnyCodable(true),
            "includeUnknown": AnyCodable(false),
        ]
        if let limit {
            params["limit"] = AnyCodable(limit)
        }
        let normalizedSearch = search?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let normalizedSearch, !normalizedSearch.isEmpty {
            params["search"] = AnyCodable(normalizedSearch)
        }
        if archived {
            params["archived"] = AnyCodable(true)
        }
        let data = try await GatewayConnection.shared.request(
            method: "sessions.list",
            params: params,
            timeoutMs: 15000)
        let decoded = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        let mainSessionKey = await GatewayConnection.shared.cachedMainSessionKey()
        let defaults = decoded.defaults.map {
            OpenClawChatSessionsDefaults(
                modelProvider: $0.modelProvider,
                model: $0.model,
                contextTokens: $0.contextTokens,
                thinkingLevels: $0.thinkingLevels,
                thinkingOptions: $0.thinkingOptions,
                thinkingDefault: $0.thinkingDefault,
                mainSessionKey: mainSessionKey)
        } ?? OpenClawChatSessionsDefaults(
            model: nil,
            contextTokens: nil,
            mainSessionKey: mainSessionKey)
        return OpenClawChatSessionsListResponse(
            ts: decoded.ts,
            path: decoded.path,
            count: decoded.count,
            defaults: defaults,
            sessions: decoded.sessions)
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        var params: [String: AnyCodable] = [
            "key": AnyCodable(sessionKey),
        ]
        params["model"] = model.map(AnyCodable.init) ?? AnyCodable(NSNull())
        _ = try await GatewayConnection.shared.request(
            method: "sessions.patch",
            params: params,
            timeoutMs: 15000)
    }

    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        let params: [String: AnyCodable] = [
            "key": AnyCodable(sessionKey),
            "thinkingLevel": AnyCodable(thinkingLevel),
        ]
        _ = try await GatewayConnection.shared.request(
            method: "sessions.patch",
            params: params,
            timeoutMs: 15000)
    }

    func patchSession(
        key: String,
        label: String??,
        category: String??,
        pinned: Bool?,
        archived: Bool?,
        unread: Bool?) async throws
    {
        var params: [String: AnyCodable] = [
            "key": AnyCodable(key),
        ]
        // Double-optionals: .some(nil) clears the field server-side (JSON null).
        if let label {
            params["label"] = label.map(AnyCodable.init) ?? AnyCodable(NSNull())
        }
        if let category {
            params["category"] = category.map(AnyCodable.init) ?? AnyCodable(NSNull())
        }
        if let pinned {
            params["pinned"] = AnyCodable(pinned)
        }
        if let archived {
            params["archived"] = AnyCodable(archived)
        }
        if let unread {
            params["unread"] = AnyCodable(unread)
        }
        _ = try await GatewayConnection.shared.request(
            method: "sessions.patch",
            params: params,
            timeoutMs: 15000)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await GatewayConnection.shared.chatSend(
            sessionKey: sessionKey,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
    }

    func sendMessage(
        sessionKey: String,
        agentID: String?,
        expectedSessionRoutingContract: String?,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        if let outboxGatewayID {
            try await Self.requireGateway(outboxGatewayID)
        }
        guard let route = await GatewayConnection.shared.captureRoute(),
              let supportsRoutingContract = await GatewayConnection.shared.supportsServerCapability(
                  .chatSendRoutingContract,
                  ifCurrentRoute: route)
        else { throw OpenClawChatTransportSendError.notDispatched }
        // Outbox replay is capability-gated in acquireOutboxRouteLease. A
        // live send keeps its captured route on older gateways and omits the
        // unsupported atomic routing field.
        let guardedContract = OpenClawChatSessionRoutingContract.expectedValue(
            expectedSessionRoutingContract,
            serverSupportsGuard: supportsRoutingContract)
        return try await GatewayConnection.shared.chatSend(
            sessionKey: sessionKey,
            agentID: agentID,
            expectedSessionRoutingContract: guardedContract,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult {
        guard let outboxGatewayID else { return .unavailable(reason: nil) }
        let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
        guard currentGatewayID == outboxGatewayID,
              let route = await GatewayConnection.shared.captureRoute()
        else { return .unavailable(reason: nil) }
        guard let supportsRoutingContract = await GatewayConnection.shared.supportsServerCapability(
            .chatSendRoutingContract,
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        guard supportsRoutingContract else {
            return .unavailable(reason: OpenClawChatTransportUpgradeMessage.routingContract)
        }
        guard let routingIdentity = try? await GatewayConnection.shared.sessionRoutingIdentity(
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        let routingContract = routingIdentity.contract
        return .available(OpenClawChatTransportRouteLease(
            sendTargetedMessage: { sessionKey, agentID, message, thinking, idempotencyKey, attachments in
                try await Self.requireGateway(outboxGatewayID)
                return try await GatewayConnection.shared.chatSend(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    expectedSessionRoutingContract: routingContract,
                    message: message,
                    thinking: thinking,
                    idempotencyKey: idempotencyKey,
                    attachments: attachments,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true)
            },
            requestTargetedHistory: { sessionKey, agentID in
                try await Self.requireGateway(outboxGatewayID)
                return try await GatewayConnection.shared.chatHistory(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    ifCurrentRoute: route)
            },
            sessionRoutingContract: routingContract))
    }

    private static func requireGateway(_ gatewayID: String) async throws {
        let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
        guard currentGatewayID == gatewayID else {
            throw OpenClawChatTransportSendError.notDispatched
        }
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        try await GatewayConnection.shared.healthOK(timeoutMs: timeoutMs)
    }

    func resetSession(sessionKey: String) async throws {
        _ = try await GatewayConnection.shared.request(
            method: "sessions.reset",
            params: ["key": AnyCodable(sessionKey)],
            timeoutMs: 10000)
    }

    func compactSession(sessionKey: String) async throws {
        let response = try await GatewayConnection.shared.request(
            method: "sessions.compact",
            params: ["key": AnyCodable(sessionKey)],
            timeoutMs: 0,
            retryTransportFailures: false)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        await MainActor.run {
            WebChatManager.shared.recordActiveSessionKey(sessionKey)
        }
        _ = try await GatewayConnection.shared.request(
            method: "sessions.messages.subscribe",
            params: ["key": AnyCodable(sessionKey)],
            timeoutMs: 10000)
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    try await GatewayConnection.shared.refresh()
                } catch {
                    webChatSwiftLogger.error("gateway refresh failed \(error.localizedDescription, privacy: .public)")
                }

                let stream = await GatewayConnection.shared.subscribe()
                for await push in stream {
                    if Task.isCancelled { return }
                    if let evt = Self.mapPushToTransportEvent(push) {
                        continuation.yield(evt)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    static func mapPushToTransportEvent(_ push: GatewayPush) -> OpenClawChatTransportEvent? {
        switch push {
        case let .snapshot(hello):
            let ok = (try? JSONDecoder().decode(
                OpenClawGatewayHealthOK.self,
                from: JSONEncoder().encode(hello.snapshot.health)))?.ok ?? true
            return .health(ok: ok)

        case let .event(evt):
            switch evt.event {
            case "health":
                guard let payload = evt.payload else { return nil }
                let ok = (try? JSONDecoder().decode(
                    OpenClawGatewayHealthOK.self,
                    from: JSONEncoder().encode(payload)))?.ok ?? true
                return .health(ok: ok)
            case "tick":
                return .tick
            case "chat":
                guard let payload = evt.payload else { return nil }
                guard let chat = try? JSONDecoder().decode(
                    OpenClawChatEventPayload.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .chat(chat)
            case "session.message":
                guard let payload = evt.payload else { return nil }
                guard let message = try? JSONDecoder().decode(
                    OpenClawSessionMessageEventPayload.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .sessionMessage(message)
            case "agent":
                guard let payload = evt.payload else { return nil }
                guard let agent = try? JSONDecoder().decode(
                    OpenClawAgentEventPayload.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .agent(agent)
            default:
                return nil
            }

        case .seqGap:
            return .seqGap
        }
    }

    private static func mapModelChoice(_ model: OpenClawProtocol.ModelChoice) -> OpenClawChatModelChoice {
        OpenClawChatModelChoice(
            modelID: model.id,
            name: model.name,
            provider: model.provider,
            contextWindow: model.contextwindow,
            reasoning: model.reasoning)
    }
}

// MARK: - Window controller

@MainActor
final class WebChatSwiftUIWindowController {
    private let presentation: WebChatPresentation
    private let sessionKey: String
    private let hosting: NSHostingController<OpenClawChatView>
    private let contentController: NSViewController
    private var window: NSWindow?
    private var dismissMonitor: Any?
    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?

    convenience init(sessionKey: String, presentation: WebChatPresentation) {
        // Connection-mode changes tear chat windows down via resetTunnels(),
        // so binding the cache identity at construction stays correct. One
        // store instance backs both the transcript cache and the offline
        // command outbox.
        let context = MacChatTranscriptCache.makeContext()
        let store = context?.store
        self.init(
            sessionKey: sessionKey,
            presentation: presentation,
            transport: MacGatewayChatTransport(outboxGatewayID: store?.gatewayID),
            initialActiveAgentID: context?.routingIdentity?.defaultAgentID,
            initialSessionRoutingContract: context?.routingIdentity?.contract,
            transcriptCache: store,
            outbox: store)
    }

    init(
        sessionKey: String,
        presentation: WebChatPresentation,
        transport: any OpenClawChatTransport,
        initialActiveAgentID: String? = nil,
        initialSessionRoutingContract: String? = nil,
        transcriptCache: (any OpenClawChatTranscriptCache)? = nil,
        outbox: (any OpenClawChatCommandOutbox)? = nil)
    {
        self.sessionKey = sessionKey
        self.presentation = presentation
        let vm = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: initialActiveAgentID,
            sessionRoutingContract: initialSessionRoutingContract,
            transcriptCache: transcriptCache,
            outbox: outbox,
            initialThinkingLevel: Self.persistedThinkingLevel(),
            onThinkingLevelChanged: { level in
                UserDefaults.standard.set(level, forKey: webChatThinkingLevelDefaultsKey)
            })
        Task { @MainActor [weak vm] in
            let pushes = await GatewayConnection.shared.subscribe()
            for await push in pushes {
                guard let vm else { return }
                guard case .snapshot = push else { continue }
                let route = await GatewayConnection.shared.captureRoute()
                let routingIdentity: GatewayConnection.SessionRoutingIdentity? = if let route {
                    try? await GatewayConnection.shared.sessionRoutingIdentity(
                        ifCurrentRoute: route)
                } else {
                    nil
                }
                if let routingIdentity {
                    if let store = transcriptCache as? OpenClawChatSQLiteTranscriptCache,
                       store.gatewayID == MacChatTranscriptCache.currentGatewayID(),
                       let persistedIdentity = OpenClawChatSessionRoutingIdentity(
                           contract: routingIdentity.contract)
                    {
                        await store.storeSessionRoutingIdentity(persistedIdentity)
                    }
                    vm.syncDeliveryIdentity(
                        activeAgentId: routingIdentity.defaultAgentID,
                        sessionRoutingContract: routingIdentity.contract)
                }
            }
        }
        let accent = Self.color(fromHex: AppStateStore.shared.seamColorHex)
        self.hosting = NSHostingController(rootView: OpenClawChatView(
            viewModel: vm,
            showsSessionSwitcher: true,
            userAccent: accent))
        self.contentController = Self.makeContentController(for: presentation, hosting: self.hosting)
        self.window = Self.makeWindow(for: presentation, contentViewController: self.contentController)
    }

    deinit {}

    var isVisible: Bool {
        self.window?.isVisible ?? false
    }

    func show() {
        guard let window else { return }
        self.ensureWindowSize()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func presentAnchored(anchorProvider: () -> NSRect?) {
        guard case .panel = self.presentation, let window else { return }
        self.installDismissMonitor()
        let target = self.reposition(using: anchorProvider)

        if !self.isVisible {
            let start = target.offsetBy(dx: 0, dy: 8)
            window.setFrame(start, display: true)
            window.alphaValue = 0
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(target, display: true)
                window.animator().alphaValue = 1
            }
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        self.onVisibilityChanged?(true)
    }

    func close() {
        self.window?.orderOut(nil)
        self.onVisibilityChanged?(false)
        self.onClosed?()
        self.removeDismissMonitor()
    }

    @discardableResult
    private func reposition(using anchorProvider: () -> NSRect?) -> NSRect {
        guard let window else { return .zero }
        guard let anchor = anchorProvider() else {
            let frame = WindowPlacement.topRightFrame(
                size: WebChatSwiftUILayout.panelSize,
                padding: WebChatSwiftUILayout.anchorPadding)
            window.setFrame(frame, display: false)
            return frame
        }
        let screen = NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(NSPoint(x: anchor.midX, y: anchor.midY))
        } ?? NSScreen.main
        let bounds = (screen?.visibleFrame ?? .zero).insetBy(
            dx: WebChatSwiftUILayout.anchorPadding,
            dy: WebChatSwiftUILayout.anchorPadding)
        let frame = WindowPlacement.anchoredBelowFrame(
            size: WebChatSwiftUILayout.panelSize,
            anchor: anchor,
            padding: WebChatSwiftUILayout.anchorPadding,
            in: bounds)
        window.setFrame(frame, display: false)
        return frame
    }

    private func installDismissMonitor() {
        if ProcessInfo.processInfo.isRunningTests { return }
        guard self.dismissMonitor == nil, self.window != nil else { return }
        self.dismissMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown])
        { [weak self] _ in
            guard let self, let win = self.window else { return }
            let pt = NSEvent.mouseLocation
            if !win.frame.contains(pt) {
                self.close()
            }
        }
    }

    private func removeDismissMonitor() {
        OverlayPanelFactory.clearGlobalEventMonitor(&self.dismissMonitor)
    }

    private static func persistedThinkingLevel() -> String? {
        let stored = UserDefaults.standard.string(forKey: webChatThinkingLevelDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let stored, ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"].contains(stored) else {
            return nil
        }
        return stored
    }

    private static func makeWindow(
        for presentation: WebChatPresentation,
        contentViewController: NSViewController) -> NSWindow
    {
        switch presentation {
        case .window:
            let window = NSWindow(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.windowSize),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false)
            window.title = "OpenClaw Chat"
            window.contentViewController = contentViewController
            window.isReleasedWhenClosed = false
            window.titleVisibility = .visible
            window.titlebarAppearsTransparent = false
            window.backgroundColor = .clear
            window.isOpaque = false
            window.center()
            WindowPlacement.ensureOnScreen(window: window, defaultSize: WebChatSwiftUILayout.windowSize)
            window.minSize = WebChatSwiftUILayout.windowMinSize
            window.contentView?.wantsLayer = true
            window.contentView?.layer?.backgroundColor = NSColor.clear.cgColor
            return window
        case .panel:
            let panel = WebChatPanel(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.panelSize),
                styleMask: [.borderless],
                backing: .buffered,
                defer: false)
            panel.level = .statusBar
            panel.hidesOnDeactivate = true
            panel.hasShadow = true
            panel.isMovable = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.contentViewController = contentViewController
            panel.becomesKeyOnlyIfNeeded = true
            panel.contentView?.wantsLayer = true
            panel.contentView?.layer?.backgroundColor = NSColor.clear.cgColor
            panel.setFrame(
                WindowPlacement.topRightFrame(
                    size: WebChatSwiftUILayout.panelSize,
                    padding: WebChatSwiftUILayout.anchorPadding),
                display: false)
            return panel
        }
    }

    private static func makeContentController(
        for presentation: WebChatPresentation,
        hosting: NSHostingController<OpenClawChatView>) -> NSViewController
    {
        let controller = NSViewController()
        let effectView = NSVisualEffectView()
        effectView.material = .sidebar
        effectView.blendingMode = switch presentation {
        case .panel:
            .withinWindow
        case .window:
            .behindWindow
        }
        effectView.state = .active
        effectView.wantsLayer = true
        effectView.layer?.cornerCurve = .continuous
        let cornerRadius: CGFloat = switch presentation {
        case .panel:
            16
        case .window:
            0
        }
        effectView.layer?.cornerRadius = cornerRadius
        effectView.layer?.masksToBounds = true
        effectView.layer?.backgroundColor = NSColor.clear.cgColor

        effectView.translatesAutoresizingMaskIntoConstraints = true
        effectView.autoresizingMask = [.width, .height]
        let rootView = effectView

        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        hosting.view.wantsLayer = true
        hosting.view.layer?.cornerCurve = .continuous
        hosting.view.layer?.cornerRadius = cornerRadius
        hosting.view.layer?.masksToBounds = true
        hosting.view.layer?.backgroundColor = NSColor.clear.cgColor

        controller.addChild(hosting)
        effectView.addSubview(hosting.view)
        controller.view = rootView

        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: effectView.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: effectView.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: effectView.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: effectView.bottomAnchor),
        ])

        return controller
    }

    private func ensureWindowSize() {
        guard case .window = self.presentation, let window else { return }
        let current = window.frame.size
        let min = WebChatSwiftUILayout.windowMinSize
        if current.width < min.width || current.height < min.height {
            let frame = WindowPlacement.centeredFrame(size: WebChatSwiftUILayout.windowSize)
            window.setFrame(frame, display: false)
        }
    }

    private static func color(fromHex raw: String?) -> Color? {
        ColorHexSupport.color(fromHex: raw)
    }
}
