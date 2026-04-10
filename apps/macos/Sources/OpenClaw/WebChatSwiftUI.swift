import AppKit
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
import QuartzCore
import SwiftUI

private let webChatSwiftLogger = Logger(subsystem: "ai.openclaw", category: "WebChatSwiftUI")
private let webChatThinkingLevelDefaultsKey = "openclaw.webchat.thinkingLevel"

private enum WebChatSwiftUILayout {
    static let windowSize = NSSize(width: 560, height: 900)
    static let panelSize = NSSize(width: 520, height: 700)
    static let windowMinSize = NSSize(width: 520, height: 420)
    static let anchorPadding: CGFloat = 10
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

    func compactSession(sessionKey: String) async throws {
        _ = try await GatewayConnection.shared.request(
            method: "sessions.compact",
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
    private final class CloseActionBox {
        var action: (() -> Void)?
    }

    private let presentation: WebChatPresentation
    private let sessionKey: String
    private let hosting: NSHostingController<MacChatChromeView>
    private let contentController: NSViewController
    private var window: NSWindow?
    private var dismissMonitor: Any?
    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?

    convenience init(sessionKey: String, presentation: WebChatPresentation) {
        self.init(sessionKey: sessionKey, presentation: presentation, transport: MacGatewayChatTransport())
    }

    init(sessionKey: String, presentation: WebChatPresentation, transport: any OpenClawChatTransport) {
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
        let closeActionBox = CloseActionBox()
        self.hosting = NSHostingController(rootView: MacChatChromeView(
            viewModel: vm,
            userAccent: accent,
            presentation: presentation,
            onClose: { closeActionBox.action?() }))
        self.contentController = Self.makeContentController(for: presentation, hosting: self.hosting)
        self.window = Self.makeWindow(for: presentation, contentViewController: self.contentController)
        closeActionBox.action = { [weak self] in self?.close() }
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
                styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                backing: .buffered,
                defer: false)
            window.title = "OpenClaw Chat"
            window.contentViewController = contentViewController
            window.isReleasedWhenClosed = false
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.backgroundColor = .clear
            window.isOpaque = false
            window.toolbarStyle = .unifiedCompact
            window.isMovableByWindowBackground = true
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
            panel.isMovableByWindowBackground = true
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
        hosting: NSHostingController<MacChatChromeView>) -> NSViewController
    {
        let controller = NSViewController()
        let effectView = NSVisualEffectView()
        effectView.material = presentation.isPanel ? .hudWindow : .underWindowBackground
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
            22
        case .window:
            0
        }
        effectView.layer?.cornerRadius = cornerRadius
        effectView.layer?.masksToBounds = true
        effectView.layer?.backgroundColor = NSColor.black.withAlphaComponent(presentation.isPanel ? 0.18 : 0.08).cgColor

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

@MainActor
private struct MacChatChromeView: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let userAccent: Color?
    let presentation: WebChatPresentation
    let onClose: () -> Void

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color.black.opacity(self.presentation.isPanel ? 0.82 : 0.74),
                    Color(red: 0.06, green: 0.08, blue: 0.12).opacity(0.94),
                    Color(red: 0.03, green: 0.04, blue: 0.07).opacity(0.98),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)

            VStack(spacing: 0) {
                self.header
                OpenClawChatView(
                    viewModel: self.viewModel,
                    showsSessionSwitcher: true,
                    userAccent: self.userAccent)
            }
        }
        .overlay(alignment: .top) {
            LinearGradient(
                colors: [.white.opacity(0.16), .clear],
                startPoint: .top,
                endPoint: .bottom)
                .frame(height: 44)
                .allowsHitTesting(false)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Circle()
                    .fill(self.viewModel.healthOK ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)

                VStack(alignment: .leading, spacing: 2) {
                    Text("OpenClaw Chat")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.96))
                    Text(self.sessionLabel)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.56))
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if self.viewModel.pendingRunCount > 0 {
                Label("\(self.viewModel.pendingRunCount)", systemImage: "sparkles")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.78))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(
                        Capsule(style: .continuous)
                            .fill(Color.white.opacity(0.08))
                            .overlay(
                                Capsule(style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.8)))
            }

            if self.presentation.isPanel {
                Button(action: self.onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white.opacity(0.8))
                        .frame(width: 24, height: 24)
                        .background(
                            Circle()
                                .fill(Color.white.opacity(0.08))
                                .overlay(Circle().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.8)))
                }
                .buttonStyle(.plain)
                .help("Close")
            }
        }
        .padding(.horizontal, self.presentation.isPanel ? 14 : 18)
        .padding(.top, self.presentation.isPanel ? 12 : 10)
        .padding(.bottom, 10)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 0.8)
        }
    }

    private var sessionLabel: String {
        let match = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        let label = match?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let label, !label.isEmpty {
            return label
        }
        return self.viewModel.sessionKey
    }
}
