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
    static let windowIdealSize = NSSize(width: 780, height: 760)
    static let correctionWindowIdealSize = NSSize(width: 1180, height: 780)
    static let panelIdealSize = NSSize(width: 520, height: 660)
    static let windowMinSize = NSSize(width: 620, height: 420)
    static let correctionWindowMinSize = NSSize(width: 980, height: 680)
    static let panelMinSize = NSSize(width: 420, height: 480)
    static let anchorPadding: CGFloat = 8

    @MainActor
    static func windowSize(for screen: NSScreen?) -> NSSize {
        AdaptiveWindowSizing.clampedSize(
            ideal: self.windowIdealSize,
            minimum: self.windowMinSize,
            padding: 40,
            on: screen)
    }

    @MainActor
    static func correctionWindowSize(for screen: NSScreen?) -> NSSize {
        AdaptiveWindowSizing.clampedSize(
            ideal: self.correctionWindowIdealSize,
            minimum: self.correctionWindowMinSize,
            padding: 40,
            on: screen)
    }

    @MainActor
    static func panelSize(for screen: NSScreen?) -> NSSize {
        AdaptiveWindowSizing.clampedSize(
            ideal: self.panelIdealSize,
            minimum: self.panelMinSize,
            padding: 20,
            on: screen)
    }
}

struct MacGatewayChatTransport: OpenClawChatTransport {
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

    func listSessions(limit: Int?) async throws -> OpenClawChatSessionsListResponse {
        var params: [String: AnyCodable] = [
            "includeGlobal": AnyCodable(true),
            "includeUnknown": AnyCodable(false),
        ]
        if let limit {
            params["limit"] = AnyCodable(limit)
        }
        let data = try await GatewayConnection.shared.request(
            method: "sessions.list",
            params: params,
            timeoutMs: 15000)
        let decoded = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        let mainSessionKey = await GatewayConnection.shared.cachedMainSessionKey()
        let defaults = decoded.defaults.map {
            OpenClawChatSessionsDefaults(
                model: $0.model,
                contextTokens: $0.contextTokens,
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

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        try await GatewayConnection.shared.healthOK(timeoutMs: timeoutMs)
    }

    func resetSession(sessionKey: String) async throws {
        _ = try await GatewayConnection.shared.request(
            method: "sessions.reset",
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
            contextWindow: model.contextwindow)
    }
}

// MARK: - Window controller

@MainActor
final class WebChatSwiftUIWindowController {
    private static let workspaceWindowCollectionBehavior: NSWindow.CollectionBehavior = [
        .primary,
        .canJoinAllSpaces,
        .fullScreenAuxiliary,
    ]

    private let presentation: WebChatPresentation
    private let sessionKey: String
    private let workspaceRouter: WebChatWorkspaceRouter?
    private let hosting: NSHostingController<AnyView>
    private let contentController: NSViewController
    private var window: NSWindow?
    private var dismissMonitor: Any?
    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?

    convenience init(
        sessionKey: String,
        presentation: WebChatPresentation,
        initialMode: WebChatWorkspaceMode = .control)
    {
        self.init(
            sessionKey: sessionKey,
            presentation: presentation,
            transport: MacGatewayChatTransport(),
            initialMode: initialMode)
    }

    init(
        sessionKey: String,
        presentation: WebChatPresentation,
        transport: any OpenClawChatTransport,
        initialMode: WebChatWorkspaceMode = .control)
    {
        self.sessionKey = sessionKey
        self.presentation = presentation
        let vm = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            initialThinkingLevel: Self.persistedThinkingLevel(),
            onThinkingLevelChanged: { level in
                UserDefaults.standard.set(level, forKey: webChatThinkingLevelDefaultsKey)
            })
        let accent = Self.color(fromHex: AppStateStore.shared.seamColorHex)
        switch presentation {
        case .window:
            let workspaceRouter = WebChatWorkspaceRouter(selectedMode: initialMode)
            self.workspaceRouter = workspaceRouter
            self.hosting = NSHostingController(rootView: AnyView(
                WebChatWorkspaceRootView(
                    router: workspaceRouter,
                    state: AppStateStore.shared,
                    chatViewModel: vm,
                    userAccent: accent)))
        case .panel:
            self.workspaceRouter = nil
            self.hosting = NSHostingController(rootView: AnyView(OpenClawChatView(
                viewModel: vm,
                showsSessionSwitcher: true,
                userAccent: accent)))
        }
        if #available(macOS 13.0, *) {
            self.hosting.sizingOptions = []
        }
        self.contentController = Self.makeContentController(for: presentation, hosting: self.hosting)
        self.window = Self.makeWindow(for: presentation, contentViewController: self.contentController)
        self.applyWorkspaceMode(initialMode, animate: false)
    }

    deinit {}

    var isVisible: Bool {
        self.window?.isVisible ?? false
    }

    func show(mode: WebChatWorkspaceMode = .control) {
        guard let window else { return }
        let wasVisible = window.isVisible
        let deferCorrectionMode: Bool
        if case .window = self.presentation {
            deferCorrectionMode = mode == .correction && !window.isVisible
        } else {
            deferCorrectionMode = false
        }
        if !deferCorrectionMode {
            self.applyWorkspaceMode(mode, animate: true)
        }
        switch self.presentation {
        case .window:
            DockIconManager.shared.temporarilyShowDockNow()
            self.ensureWindowSize(mode: mode, force: !wasVisible)
            self.promoteWindowToForeground(window)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                self.ensureWindowSize(mode: mode, force: !wasVisible)
                self.promoteWindowToForeground(window)
            }
        case .panel:
            self.ensureWindowSize()
            window.makeKeyAndOrderFront(nil)
            window.orderFrontRegardless()
            DockIconManager.shared.updateDockVisibilityNow()
            NSApp.activate(ignoringOtherApps: true)
        }
        if deferCorrectionMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                self?.applyWorkspaceMode(mode, animate: true)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self, weak window] in
            guard let self, let window else { return }
            if case .window = self.presentation,
               (!window.isKeyWindow || !window.isMainWindow || !window.isVisible)
            {
                self.promoteWindowToForeground(window)
            }
        }
        self.onVisibilityChanged?(true)
    }

    private func promoteWindowToForeground(_ window: NSWindow) {
        DockIconManager.shared.temporarilyShowDockNow()
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
        NSApp.activate(ignoringOtherApps: true)
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
            DockIconManager.shared.updateDockVisibilityNow()
            NSApp.activate(ignoringOtherApps: true)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(target, display: true)
                window.animator().alphaValue = 1
            }
        } else {
            window.makeKeyAndOrderFront(nil)
            DockIconManager.shared.updateDockVisibilityNow()
            NSApp.activate(ignoringOtherApps: true)
        }

        self.onVisibilityChanged?(true)
    }

    func close() {
        self.window?.orderOut(nil)
        DockIconManager.shared.updateDockVisibilityNow()
        self.onVisibilityChanged?(false)
        self.onClosed?()
        self.removeDismissMonitor()
    }

    @discardableResult
    private func reposition(using anchorProvider: () -> NSRect?) -> NSRect {
        guard let window else { return .zero }
        let screen = window.screen ?? NSScreen.main
        let panelSize = WebChatSwiftUILayout.panelSize(for: screen)
        guard let anchor = anchorProvider() else {
            let frame = WindowPlacement.topRightFrame(
                size: panelSize,
                padding: WebChatSwiftUILayout.anchorPadding,
                on: screen)
            window.setFrame(frame, display: false)
            return frame
        }
        let targetScreen = NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(NSPoint(x: anchor.midX, y: anchor.midY))
        } ?? screen
        let bounds = (targetScreen?.visibleFrame ?? .zero).insetBy(
            dx: WebChatSwiftUILayout.anchorPadding,
            dy: WebChatSwiftUILayout.anchorPadding)
        let frame = WindowPlacement.anchoredBelowFrame(
            size: WebChatSwiftUILayout.panelSize(for: targetScreen),
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
            let windowSize = WebChatSwiftUILayout.windowSize(for: NSScreen.main)
            let window = NSWindow(
                contentRect: NSRect(origin: .zero, size: windowSize),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false)
            window.title = Branding.chatWindowTitle
            window.contentViewController = contentViewController
            window.isReleasedWhenClosed = false
            window.titleVisibility = .visible
            window.titlebarAppearsTransparent = false
            window.backgroundColor = .clear
            window.isOpaque = false
            window.collectionBehavior = Self.workspaceWindowCollectionBehavior
            window.center()
            WindowPlacement.ensureOnScreen(window: window, defaultSize: windowSize)
            window.minSize = WebChatSwiftUILayout.windowMinSize
            window.contentView?.wantsLayer = true
            window.contentView?.layer?.backgroundColor = NSColor.clear.cgColor
            return window
        case .panel:
            let panelSize = WebChatSwiftUILayout.panelSize(for: NSScreen.main)
            let panel = WebChatPanel(
                contentRect: NSRect(origin: .zero, size: panelSize),
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
                    size: panelSize,
                    padding: WebChatSwiftUILayout.anchorPadding,
                    on: NSScreen.main),
                display: false)
            return panel
        }
    }

    private static func makeContentController(
        for presentation: WebChatPresentation,
        hosting: NSHostingController<AnyView>) -> NSViewController
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
        guard case .window = self.presentation else { return }
        self.ensureWindowSize(mode: self.workspaceRouter?.selectedMode ?? .control, force: false)
    }

    private func ensureWindowSize(mode: WebChatWorkspaceMode, force: Bool) {
        guard case .window = self.presentation, let window else { return }
        let current = window.frame.size
        let isCorrection = mode == .correction
        let min = isCorrection
            ? WebChatSwiftUILayout.correctionWindowMinSize
            : WebChatSwiftUILayout.windowMinSize
        let screen = window.screen ?? NSScreen.main
        let targetSize = isCorrection
                ? WebChatSwiftUILayout.correctionWindowSize(for: screen)
                : WebChatSwiftUILayout.windowSize(for: screen)
        let visibleSize = screen?.visibleFrame.size ?? targetSize
        let exceedsVisibleFrame = current.width > visibleSize.width || current.height > visibleSize.height
        let centeredFrame = WindowPlacement.centeredFrame(size: targetSize, on: screen)

        if !Self.isFrameVisibleOnAnyScreen(window.frame) {
            window.setFrame(centeredFrame, display: false)
            return
        }

        guard force || current.width < min.width || current.height < min.height || exceedsVisibleFrame else { return }

        window.setFrame(centeredFrame, display: false)
    }

    private func applyWorkspaceMode(_ mode: WebChatWorkspaceMode, animate: Bool) {
        guard case .window = self.presentation, let window else { return }
        self.workspaceRouter?.selectedMode = mode
        window.title = mode.windowTitle
        window.minSize = mode == .correction
            ? WebChatSwiftUILayout.correctionWindowMinSize
            : WebChatSwiftUILayout.windowMinSize

        guard mode == .correction else { return }
        let minSize = WebChatSwiftUILayout.correctionWindowMinSize
        guard window.frame.width < minSize.width || window.frame.height < minSize.height else { return }

        let screen = window.screen ?? NSScreen.main
        let frame = WindowPlacement.centeredFrame(
            size: WebChatSwiftUILayout.correctionWindowSize(for: screen),
            on: screen)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            window.setFrame(frame, display: true, animate: false)
        }
    }

    private static func color(fromHex raw: String?) -> Color? {
        ColorHexSupport.color(fromHex: raw)
    }

    private static func isFrameVisibleOnAnyScreen(_ frame: NSRect) -> Bool {
        let screens = NSScreen.screens
        if screens.isEmpty {
            return frame.width > 1 && frame.height > 1
        }

        return screens.contains { screen in
            frame.intersects(screen.visibleFrame.insetBy(dx: 12, dy: 12))
        }
    }
}
