import AppKit
import AVFoundation
import Foundation
import ObjectiveC
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
    private let presentation: WebChatPresentation
    private let sessionKey: String
    private let hosting: NSHostingController<OpenClawChatView>
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
        vm.directImageGenHandler = GoogleImageGenService.shared
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

            // Add toolbar with gear menu
            let toolbar = NSToolbar(identifier: "OpenClawChatToolbar")
            toolbar.displayMode = .iconOnly
            if #available(macOS 26.0, *) {
                window.toolbarStyle = .unifiedCompact
            } else {
                window.toolbarStyle = .unified
            }
            let toolbarDelegate = ChatWindowToolbarDelegate()
            toolbar.delegate = toolbarDelegate
            window.toolbar = toolbar
            // Retain the delegate (toolbar doesn't retain its delegate)
            objc_setAssociatedObject(window, &chatToolbarDelegateKey, toolbarDelegate, .OBJC_ASSOCIATION_RETAIN)

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


// MARK: - Chat window toolbar

nonisolated(unsafe) private var chatToolbarDelegateKey: UInt8 = 0

private extension NSToolbarItem.Identifier {
    static let chatGearMenu = NSToolbarItem.Identifier("chatGearMenu")
}

// MARK: - Tags for gear menu items
private enum GearMenuTag {
    static let connection = 100
    static let healthStatus = 101
    static let pairingStatus = 102
    static let heartbeats = 110
    static let heartbeatStatus = 111
    static let browserControl = 112
    static let camera = 113
    static let execApprovals = 114
    static let canvasEnabled = 115
    static let voiceWake = 116
    static let micSubmenu = 117
    static let openDashboard = 120
    static let openChat = 121
    static let openCloseCanvas = 122
    static let talkMode = 123
    static let debugSubmenu = 130
    static let about = 131
    static let update = 132
}

@MainActor
final class ChatWindowToolbarDelegate: NSObject, NSToolbarDelegate {
    private var browserControlEnabled = true

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem?
    {
        guard itemIdentifier == .chatGearMenu else { return nil }

        let item = NSMenuToolbarItem(itemIdentifier: itemIdentifier)
        let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        item.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: "Settings")?
            .withSymbolConfiguration(config)
        item.label = "Settings"
        item.toolTip = "App settings and controls"
        item.menu = self.buildGearMenu()
        item.showsIndicator = true
        return item
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .chatGearMenu]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .chatGearMenu]
    }

    // MARK: - Build full gear menu (mirrors MenuContentView)

    private func buildGearMenu() -> NSMenu {
        let menu = NSMenu()
        let state = AppStateStore.shared

        // ── Connection toggle ──
        let connItem = NSMenuItem(
            title: state.isPaused ? "OpenClaw Paused" : self.connectionLabel(state),
            action: #selector(toggleConnection),
            keyEquivalent: "")
        connItem.target = self
        connItem.tag = GearMenuTag.connection
        connItem.state = state.isPaused ? .off : .on
        connItem.image = NSImage(systemSymbolName: "antenna.radiowaves.left.and.right", accessibilityDescription: nil)
        connItem.isEnabled = state.connectionMode != .unconfigured
        menu.addItem(connItem)

        // Health status (info-only)
        let healthItem = NSMenuItem(title: "Health pending", action: nil, keyEquivalent: "")
        healthItem.tag = GearMenuTag.healthStatus
        healthItem.isEnabled = false
        menu.addItem(healthItem)

        // Pairing status (info-only, hidden by default)
        let pairingItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        pairingItem.tag = GearMenuTag.pairingStatus
        pairingItem.isEnabled = false
        pairingItem.isHidden = true
        menu.addItem(pairingItem)

        menu.addItem(.separator())

        // ── Heartbeats toggle ──
        let hbItem = NSMenuItem(
            title: "Send Heartbeats",
            action: #selector(toggleHeartbeats),
            keyEquivalent: "")
        hbItem.target = self
        hbItem.tag = GearMenuTag.heartbeats
        hbItem.state = state.heartbeatsEnabled ? .on : .off
        hbItem.image = NSImage(systemSymbolName: "waveform.path.ecg", accessibilityDescription: nil)
        menu.addItem(hbItem)

        // Heartbeat status (info-only)
        let hbStatusItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        hbStatusItem.tag = GearMenuTag.heartbeatStatus
        hbStatusItem.isEnabled = false
        hbStatusItem.isHidden = true
        menu.addItem(hbStatusItem)

        // ── Browser Control toggle ──
        let browserItem = NSMenuItem(
            title: "Browser Control",
            action: #selector(toggleBrowserControl),
            keyEquivalent: "")
        browserItem.target = self
        browserItem.tag = GearMenuTag.browserControl
        browserItem.state = self.browserControlEnabled ? .on : .off
        browserItem.image = NSImage(systemSymbolName: "globe", accessibilityDescription: nil)
        menu.addItem(browserItem)

        // ── Allow Camera toggle ──
        let cameraItem = NSMenuItem(
            title: "Allow Camera",
            action: #selector(toggleCamera),
            keyEquivalent: "")
        cameraItem.target = self
        cameraItem.tag = GearMenuTag.camera
        cameraItem.state = UserDefaults.standard.bool(forKey: cameraEnabledKey) ? .on : .off
        cameraItem.image = NSImage(systemSymbolName: "camera", accessibilityDescription: nil)
        menu.addItem(cameraItem)

        // ── Exec Approvals submenu ──
        let execItem = NSMenuItem(title: "Exec Approvals", action: nil, keyEquivalent: "")
        execItem.tag = GearMenuTag.execApprovals
        execItem.image = NSImage(systemSymbolName: "terminal", accessibilityDescription: nil)
        let execSub = NSMenu()
        for mode in ExecApprovalQuickMode.allCases {
            let modeItem = NSMenuItem(
                title: mode.title,
                action: #selector(selectExecApprovalMode(_:)),
                keyEquivalent: "")
            modeItem.target = self
            modeItem.representedObject = mode.rawValue
            modeItem.state = state.execApprovalMode == mode ? .on : .off
            execSub.addItem(modeItem)
        }
        execItem.submenu = execSub
        menu.addItem(execItem)

        // ── Allow Canvas toggle ──
        let canvasItem = NSMenuItem(
            title: "Allow Canvas",
            action: #selector(toggleCanvasEnabled),
            keyEquivalent: "")
        canvasItem.target = self
        canvasItem.tag = GearMenuTag.canvasEnabled
        canvasItem.state = state.canvasEnabled ? .on : .off
        canvasItem.image = NSImage(systemSymbolName: "rectangle.and.pencil.and.ellipsis", accessibilityDescription: nil)
        menu.addItem(canvasItem)

        // ── Voice Wake toggle ──
        let vwItem = NSMenuItem(
            title: "Voice Wake",
            action: #selector(toggleVoiceWake),
            keyEquivalent: "")
        vwItem.target = self
        vwItem.tag = GearMenuTag.voiceWake
        vwItem.state = state.swabbleEnabled ? .on : .off
        vwItem.image = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: nil)
        vwItem.isEnabled = voiceWakeSupported
        menu.addItem(vwItem)

        // ── Microphone submenu ──
        let micItem = NSMenuItem(title: "Microphone", action: nil, keyEquivalent: "")
        micItem.tag = GearMenuTag.micSubmenu
        micItem.submenu = NSMenu() // populated dynamically
        micItem.isHidden = !(voiceWakeSupported && state.swabbleEnabled)
        menu.addItem(micItem)

        menu.addItem(.separator())

        // ── Open Dashboard ──
        let dashItem = NSMenuItem(
            title: "Open Dashboard",
            action: #selector(openDashboard),
            keyEquivalent: "")
        dashItem.target = self
        dashItem.tag = GearMenuTag.openDashboard
        dashItem.image = NSImage(systemSymbolName: "gauge", accessibilityDescription: nil)
        menu.addItem(dashItem)

        // ── Open Chat ──
        let chatItem = NSMenuItem(
            title: "Open Chat",
            action: #selector(openNewChat),
            keyEquivalent: "")
        chatItem.target = self
        chatItem.tag = GearMenuTag.openChat
        chatItem.image = NSImage(systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: nil)
        menu.addItem(chatItem)

        // ── Open / Close Canvas ──
        if state.canvasEnabled {
            let canvasBtnItem = NSMenuItem(
                title: state.canvasPanelVisible ? "Close Canvas" : "Open Canvas",
                action: #selector(toggleCanvasPanel),
                keyEquivalent: "")
            canvasBtnItem.target = self
            canvasBtnItem.tag = GearMenuTag.openCloseCanvas
            canvasBtnItem.image = NSImage(systemSymbolName: "rectangle.inset.filled.on.rectangle", accessibilityDescription: nil)
            menu.addItem(canvasBtnItem)
        }

        // ── Talk Mode toggle ──
        let talkItem = NSMenuItem(
            title: state.talkEnabled ? "Stop Talk Mode" : "Talk Mode",
            action: #selector(toggleTalkMode),
            keyEquivalent: "")
        talkItem.target = self
        talkItem.tag = GearMenuTag.talkMode
        talkItem.state = state.talkEnabled ? .on : .off
        talkItem.image = NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: nil)
        talkItem.isEnabled = voiceWakeSupported
        menu.addItem(talkItem)

        menu.addItem(.separator())

        // ── Settings ──
        let settingsItem = NSMenuItem(
            title: "Settings…",
            action: #selector(openSettings),
            keyEquivalent: ",")
        settingsItem.keyEquivalentModifierMask = .command
        settingsItem.target = self
        settingsItem.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)
        menu.addItem(settingsItem)

        // ── Debug submenu (conditional) ──
        if state.debugPaneEnabled {
            let debugItem = NSMenuItem(title: "Debug", action: nil, keyEquivalent: "")
            debugItem.tag = GearMenuTag.debugSubmenu
            debugItem.submenu = self.buildDebugSubmenu()
            menu.addItem(debugItem)
        }

        // ── About ──
        let aboutItem = NSMenuItem(
            title: "About OpenClaw",
            action: #selector(openAbout),
            keyEquivalent: "")
        aboutItem.target = self
        aboutItem.tag = GearMenuTag.about
        menu.addItem(aboutItem)

        // ── Update ready (conditional) ──
        if let updater = (NSApp.delegate as? AppDelegate)?.updaterController,
           updater.isAvailable, updater.updateStatus.isUpdateReady
        {
            let updateItem = NSMenuItem(
                title: "Update ready, restart now?",
                action: #selector(checkForUpdate),
                keyEquivalent: "")
            updateItem.target = self
            updateItem.tag = GearMenuTag.update
            menu.addItem(updateItem)
        }

        menu.addItem(.separator())

        // ── Quit ──
        let quitItem = NSMenuItem(
            title: "Quit OpenClaw",
            action: #selector(quitApp),
            keyEquivalent: "q")
        quitItem.keyEquivalentModifierMask = .command
        quitItem.target = self
        menu.addItem(quitItem)

        menu.delegate = self
        return menu
    }

    // MARK: - Debug submenu

    private func buildDebugSubmenu() -> NSMenu {
        let sub = NSMenu()
        let state = AppStateStore.shared

        sub.addItem(self.debugMenuItem("Open Config Folder", icon: "folder", action: #selector(debugOpenConfigFolder)))
        sub.addItem(self.debugMenuItem("Run Health Check Now", icon: "stethoscope", action: #selector(debugRunHealthCheck)))
        sub.addItem(self.debugMenuItem("Send Test Heartbeat", icon: "waveform.path.ecg", action: #selector(debugSendTestHeartbeat)))

        if state.connectionMode == .remote {
            sub.addItem(self.debugMenuItem("Reset Remote Tunnel", icon: "arrow.triangle.2.circlepath", action: #selector(debugResetTunnel)))
        }

        // Verbose Logging (Main)
        let verboseItem = NSMenuItem(
            title: DebugActions.verboseLoggingEnabledMain
                ? "Verbose Logging (Main): On"
                : "Verbose Logging (Main): Off",
            action: #selector(debugToggleVerboseMain),
            keyEquivalent: "")
        verboseItem.target = self
        verboseItem.image = NSImage(systemSymbolName: "text.alignleft", accessibilityDescription: nil)
        sub.addItem(verboseItem)

        // App Logging submenu
        let logItem = NSMenuItem(title: "App Logging", action: nil, keyEquivalent: "")
        logItem.image = NSImage(systemSymbolName: "doc.text", accessibilityDescription: nil)
        let logSub = NSMenu()
        let currentLevel = UserDefaults.standard.string(forKey: appLogLevelKey) ?? AppLogLevel.default.rawValue
        for level in AppLogLevel.allCases {
            let li = NSMenuItem(
                title: level.title,
                action: #selector(selectAppLogLevel(_:)),
                keyEquivalent: "")
            li.target = self
            li.representedObject = level.rawValue
            li.state = level.rawValue == currentLevel ? .on : .off
            logSub.addItem(li)
        }
        logSub.addItem(.separator())
        let fileLogItem = NSMenuItem(
            title: UserDefaults.standard.bool(forKey: debugFileLogEnabledKey)
                ? "File Logging: On" : "File Logging: Off",
            action: #selector(debugToggleFileLogging),
            keyEquivalent: "")
        fileLogItem.target = self
        fileLogItem.image = NSImage(systemSymbolName: "doc.text.magnifyingglass", accessibilityDescription: nil)
        fileLogItem.state = UserDefaults.standard.bool(forKey: debugFileLogEnabledKey) ? .on : .off
        logSub.addItem(fileLogItem)
        logItem.submenu = logSub
        sub.addItem(logItem)

        sub.addItem(self.debugMenuItem("Open Session Store", icon: "externaldrive", action: #selector(debugOpenSessionStore)))

        sub.addItem(.separator())

        sub.addItem(self.debugMenuItem("Open Agent Events…", icon: "bolt.horizontal.circle", action: #selector(debugOpenAgentEvents)))
        sub.addItem(self.debugMenuItem("Open Log", icon: "doc.text.magnifyingglass", action: #selector(debugOpenLog)))
        sub.addItem(self.debugMenuItem("Send Debug Voice Text", icon: "waveform.circle", action: #selector(debugSendVoice)))
        sub.addItem(self.debugMenuItem("Send Test Notification", icon: "bell", action: #selector(debugSendNotification)))

        sub.addItem(.separator())

        if state.connectionMode == .local {
            sub.addItem(self.debugMenuItem("Restart Gateway", icon: "arrow.clockwise", action: #selector(debugRestartGateway)))
        }
        sub.addItem(self.debugMenuItem("Restart Onboarding", icon: "arrow.counterclockwise", action: #selector(debugRestartOnboarding)))
        sub.addItem(self.debugMenuItem("Restart App", icon: "arrow.triangle.2.circlepath", action: #selector(debugRestartApp)))

        return sub
    }

    private func debugMenuItem(_ title: String, icon: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = NSImage(systemSymbolName: icon, accessibilityDescription: nil)
        return item
    }

    // MARK: - Connection helpers

    private func connectionLabel(_ state: AppState) -> String {
        switch state.connectionMode {
        case .unconfigured: "OpenClaw Not Configured"
        case .remote: "Remote OpenClaw Active"
        case .local: "OpenClaw Active"
        }
    }

    private func healthStatusText() -> (String, Bool) {
        let store = HealthStore.shared
        let activity = WorkActivityStore.shared.current
        if let activity {
            let roleLabel = activity.role == .main ? "Main" : "Other"
            return ("    \(roleLabel) · \(activity.label)", false)
        }
        switch store.state {
        case .ok:
            return ("    ● Health ok", false)
        case .linkingNeeded:
            return ("    ● Login required", true)
        case let .degraded(reason):
            let detail = store.degradedSummary ?? reason
            return ("    ● \(detail)", true)
        case .unknown:
            return ("    ● Health pending", false)
        }
    }

    private func heartbeatStatusText() -> String? {
        if case .degraded = ControlChannel.shared.state {
            return "    ● Control channel disconnected"
        }
        if let evt = HeartbeatStore.shared.lastEvent {
            switch evt.status {
            case "ok-empty", "ok-token": return "    ● Heartbeat ok"
            case "sent": return "    ● Heartbeat sent"
            case "skipped": return "    ● Heartbeat skipped"
            case "failed": return "    ● Heartbeat failed"
            default: return nil
            }
        }
        return nil
    }

    // MARK: - Microphone helpers

    private func populateMicSubmenu(_ submenu: NSMenu) {
        submenu.removeAllItems()
        let state = AppStateStore.shared

        // System default option
        let defaultLabel: String
        if let host = Host.current().localizedName, !host.isEmpty {
            defaultLabel = "Auto-detect (\(host))"
        } else {
            defaultLabel = "System default"
        }
        let defaultItem = NSMenuItem(
            title: defaultLabel,
            action: #selector(selectMicrophone(_:)),
            keyEquivalent: "")
        defaultItem.target = self
        defaultItem.representedObject = "" as String
        defaultItem.state = state.voiceWakeMicID.isEmpty ? .on : .off
        submenu.addItem(defaultItem)

        submenu.addItem(.separator())

        // Discovered mics
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        let mics = discovery.devices
            .filter(\.isConnected)
            .sorted { $0.localizedName.localizedCaseInsensitiveCompare($1.localizedName) == .orderedAscending }

        for mic in mics {
            let micItem = NSMenuItem(
                title: mic.localizedName,
                action: #selector(selectMicrophone(_:)),
                keyEquivalent: "")
            micItem.target = self
            micItem.representedObject = mic.uniqueID
            micItem.state = state.voiceWakeMicID == mic.uniqueID ? .on : .off
            submenu.addItem(micItem)
        }
    }

    // MARK: - Actions: Connection & Toggles

    @objc private func toggleConnection() {
        AppStateStore.shared.isPaused.toggle()
    }

    @objc private func toggleHeartbeats() {
        AppStateStore.shared.heartbeatsEnabled.toggle()
    }

    @objc private func toggleBrowserControl() {
        self.browserControlEnabled.toggle()
        let enabled = self.browserControlEnabled
        Task {
            var root = await ConfigStore.load()
            var browser = root["browser"] as? [String: Any] ?? [:]
            browser["enabled"] = enabled
            root["browser"] = browser
            try? await ConfigStore.save(root)
        }
    }

    @objc private func toggleCamera() {
        let current = UserDefaults.standard.bool(forKey: cameraEnabledKey)
        UserDefaults.standard.set(!current, forKey: cameraEnabledKey)
    }

    @objc private func selectExecApprovalMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let mode = ExecApprovalQuickMode(rawValue: raw)
        else { return }
        AppStateStore.shared.execApprovalMode = mode
    }

    @objc private func toggleCanvasEnabled() {
        let state = AppStateStore.shared
        state.canvasEnabled.toggle()
        if !state.canvasEnabled {
            CanvasManager.shared.hideAll()
        }
    }

    @objc private func toggleVoiceWake() {
        AppStateStore.shared.swabbleEnabled.toggle()
    }

    @objc private func selectMicrophone(_ sender: NSMenuItem) {
        guard let uid = sender.representedObject as? String else { return }
        let state = AppStateStore.shared
        state.voiceWakeMicID = uid
        if uid.isEmpty {
            state.voiceWakeMicName = ""
        } else {
            state.voiceWakeMicName = sender.title
        }
    }

    // MARK: - Actions: Navigation

    @objc private func openDashboard() {
        Task { @MainActor in
            do {
                let config = try await GatewayEndpointStore.shared.requireConfig()
                let url = try GatewayEndpointStore.dashboardURL(for: config, mode: AppStateStore.shared.connectionMode)
                NSWorkspace.shared.open(url)
            } catch {
                let alert = NSAlert()
                alert.messageText = "Dashboard unavailable"
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
        }
    }

    @objc private func openNewChat() {
        Task { @MainActor in
            let sessionKey = await WebChatManager.shared.preferredSessionKey()
            WebChatManager.shared.show(sessionKey: sessionKey)
        }
    }

    @objc private func toggleCanvasPanel() {
        Task { @MainActor in
            if AppStateStore.shared.canvasPanelVisible {
                CanvasManager.shared.hideAll()
            } else {
                let sessionKey = await GatewayConnection.shared.mainSessionKey()
                _ = try? CanvasManager.shared.show(sessionKey: sessionKey, path: nil)
            }
        }
    }

    @objc private func toggleTalkMode() {
        Task { await AppStateStore.shared.setTalkEnabled(!AppStateStore.shared.talkEnabled) }
    }

    // MARK: - Actions: Settings / About / Update / Quit

    @objc private func openSettings() {
        SettingsWindowOpener.shared.open()
    }

    @objc private func openAbout() {
        SettingsTabRouter.request(.about)
        NSApp.activate(ignoringOtherApps: true)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: SettingsTab.about)
        }
    }

    @objc private func checkForUpdate() {
        (NSApp.delegate as? AppDelegate)?.updaterController.checkForUpdates(nil)
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    // MARK: - Actions: Debug

    @objc private func debugOpenConfigFolder() { DebugActions.openConfigFolder() }
    @objc private func debugRunHealthCheck() { Task { await DebugActions.runHealthCheckNow() } }
    @objc private func debugSendTestHeartbeat() { Task { _ = await DebugActions.sendTestHeartbeat() } }
    @objc private func debugResetTunnel() {
        Task { @MainActor in
            let result = await DebugActions.resetGatewayTunnel()
            let alert = NSAlert()
            alert.messageText = "Remote Tunnel"
            switch result {
            case let .success(msg): alert.informativeText = msg; alert.alertStyle = .informational
            case let .failure(err): alert.informativeText = err.localizedDescription; alert.alertStyle = .warning
            }
            alert.runModal()
        }
    }
    @objc private func debugToggleVerboseMain() { Task { _ = await DebugActions.toggleVerboseLoggingMain() } }
    @objc private func selectAppLogLevel(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String else { return }
        UserDefaults.standard.set(raw, forKey: appLogLevelKey)
    }
    @objc private func debugToggleFileLogging() {
        let current = UserDefaults.standard.bool(forKey: debugFileLogEnabledKey)
        UserDefaults.standard.set(!current, forKey: debugFileLogEnabledKey)
    }
    @objc private func debugOpenSessionStore() { DebugActions.openSessionStore() }
    @objc private func debugOpenAgentEvents() { DebugActions.openAgentEventsWindow() }
    @objc private func debugOpenLog() { DebugActions.openLog() }
    @objc private func debugSendVoice() { Task { _ = await DebugActions.sendDebugVoice() } }
    @objc private func debugSendNotification() { Task { await DebugActions.sendTestNotification() } }
    @objc private func debugRestartGateway() { DebugActions.restartGateway() }
    @objc private func debugRestartOnboarding() { DebugActions.restartOnboarding() }
    @objc private func debugRestartApp() { DebugActions.restartApp() }
}

// MARK: - NSMenuDelegate: refresh all states on open

extension ChatWindowToolbarDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        let state = AppStateStore.shared

        // Connection toggle
        if let item = menu.item(withTag: GearMenuTag.connection) {
            item.title = state.isPaused ? "OpenClaw Paused" : self.connectionLabel(state)
            item.state = state.isPaused ? .off : .on
            item.isEnabled = state.connectionMode != .unconfigured
        }

        // Health status
        if let item = menu.item(withTag: GearMenuTag.healthStatus) {
            let (text, _) = self.healthStatusText()
            item.title = text
        }

        // Pairing status
        if let item = menu.item(withTag: GearMenuTag.pairingStatus) {
            let nodePending = NodePairingApprovalPrompter.shared.pendingCount
            let devicePending = DevicePairingApprovalPrompter.shared.pendingCount
            let total = nodePending + devicePending
            if total > 0 {
                item.title = "    ⚠ Pairing approval pending (\(total))"
                item.isHidden = false
            } else {
                item.isHidden = true
            }
        }

        // Heartbeats
        if let item = menu.item(withTag: GearMenuTag.heartbeats) {
            item.state = state.heartbeatsEnabled ? .on : .off
        }
        if let item = menu.item(withTag: GearMenuTag.heartbeatStatus) {
            if let text = self.heartbeatStatusText() {
                item.title = text
                item.isHidden = false
            } else {
                item.isHidden = true
            }
        }

        // Browser Control
        Task {
            let root = await ConfigStore.load()
            let browser = root["browser"] as? [String: Any]
            let enabled = browser?["enabled"] as? Bool ?? true
            await MainActor.run { self.browserControlEnabled = enabled }
        }
        if let item = menu.item(withTag: GearMenuTag.browserControl) {
            item.state = self.browserControlEnabled ? .on : .off
        }

        // Camera
        if let item = menu.item(withTag: GearMenuTag.camera) {
            item.state = UserDefaults.standard.bool(forKey: cameraEnabledKey) ? .on : .off
        }

        // Exec Approvals
        if let item = menu.item(withTag: GearMenuTag.execApprovals),
           let sub = item.submenu
        {
            for mi in sub.items {
                if let raw = mi.representedObject as? String,
                   let mode = ExecApprovalQuickMode(rawValue: raw)
                {
                    mi.state = state.execApprovalMode == mode ? .on : .off
                }
            }
        }

        // Canvas enabled
        if let item = menu.item(withTag: GearMenuTag.canvasEnabled) {
            item.state = state.canvasEnabled ? .on : .off
        }

        // Voice Wake
        if let item = menu.item(withTag: GearMenuTag.voiceWake) {
            item.state = state.swabbleEnabled ? .on : .off
        }

        // Microphone submenu visibility and content
        if let item = menu.item(withTag: GearMenuTag.micSubmenu) {
            let shouldShow = voiceWakeSupported && state.swabbleEnabled
            item.isHidden = !shouldShow
            if shouldShow, let sub = item.submenu {
                self.populateMicSubmenu(sub)
            }
        }

        // Open / Close Canvas — add or remove dynamically
        let existingCanvasBtn = menu.item(withTag: GearMenuTag.openCloseCanvas)
        if state.canvasEnabled {
            if let item = existingCanvasBtn {
                item.title = state.canvasPanelVisible ? "Close Canvas" : "Open Canvas"
            } else {
                // Insert before Talk Mode
                if let talkIdx = menu.items.firstIndex(where: { $0.tag == GearMenuTag.talkMode }) {
                    let canvasBtnItem = NSMenuItem(
                        title: state.canvasPanelVisible ? "Close Canvas" : "Open Canvas",
                        action: #selector(toggleCanvasPanel),
                        keyEquivalent: "")
                    canvasBtnItem.target = self
                    canvasBtnItem.tag = GearMenuTag.openCloseCanvas
                    canvasBtnItem.image = NSImage(systemSymbolName: "rectangle.inset.filled.on.rectangle", accessibilityDescription: nil)
                    menu.insertItem(canvasBtnItem, at: talkIdx)
                }
            }
        } else {
            if let item = existingCanvasBtn, let idx = menu.items.firstIndex(of: item) {
                menu.removeItem(at: idx)
            }
        }

        // Talk Mode
        if let item = menu.item(withTag: GearMenuTag.talkMode) {
            let enabled = state.talkEnabled
            item.title = enabled ? "Stop Talk Mode" : "Talk Mode"
            item.state = enabled ? .on : .off
        }

        // Update item — show/hide dynamically
        let existingUpdate = menu.item(withTag: GearMenuTag.update)
        if let updater = (NSApp.delegate as? AppDelegate)?.updaterController,
           updater.isAvailable, updater.updateStatus.isUpdateReady
        {
            if existingUpdate == nil {
                // Insert before quit
                let updateItem = NSMenuItem(
                    title: "Update ready, restart now?",
                    action: #selector(checkForUpdate),
                    keyEquivalent: "")
                updateItem.target = self
                updateItem.tag = GearMenuTag.update
                if let quitIdx = menu.items.lastIndex(where: { $0.title == "Quit OpenClaw" }) {
                    menu.insertItem(updateItem, at: quitIdx)
                }
            }
        } else if let item = existingUpdate, let idx = menu.items.firstIndex(of: item) {
            menu.removeItem(at: idx)
        }
    }
}


// MARK: - Direct Image Generation Bridge

extension GoogleImageGenService: DirectImageGenHandler {
    public func generateImage(
        prompt: String,
        model: String,
        inputImage: Data?,
        inputMimeType: String,
        resolution: String,
        aspectRatio: String
    ) async throws -> DirectImageGenResult {
        let result = try await self.generate(
            prompt: prompt,
            model: model,
            inputImage: inputImage,
            inputMimeType: inputMimeType,
            resolution: resolution,
            aspectRatio: aspectRatio)
        return DirectImageGenResult(
            imageData: result.imageData,
            mimeType: result.mimeType,
            text: result.text)
    }
}
