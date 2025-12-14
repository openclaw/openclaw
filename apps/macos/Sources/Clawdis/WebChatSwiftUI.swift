import AppKit
import ClawdisChatUI
import ClawdisProtocol
import Foundation
import OSLog
import SwiftUI

private let webChatSwiftLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChatSwiftUI")

private enum WebChatSwiftUILayout {
    static let windowSize = NSSize(width: 1120, height: 840)
    static let panelSize = NSSize(width: 480, height: 640)
    static let anchorPadding: CGFloat = 8
}

struct MacGatewayChatTransport: ClawdisChatTransport, Sendable {
    func requestHistory(sessionKey: String) async throws -> ClawdisChatHistoryPayload {
        let data = try await GatewayConnection.shared.request(
            method: "chat.history",
            params: ["sessionKey": AnyCodable(sessionKey)])
        return try JSONDecoder().decode(ClawdisChatHistoryPayload.self, from: data)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [ClawdisChatAttachmentPayload]) async throws -> ClawdisChatSendResponse
    {
        var params: [String: AnyCodable] = [
            "sessionKey": AnyCodable(sessionKey),
            "message": AnyCodable(message),
            "thinking": AnyCodable(thinking),
            "idempotencyKey": AnyCodable(idempotencyKey),
            "timeoutMs": AnyCodable(30000),
        ]

        if !attachments.isEmpty {
            let encoded = attachments.map { att in
                [
                    "type": att.type,
                    "mimeType": att.mimeType,
                    "fileName": att.fileName,
                    "content": att.content,
                ]
            }
            params["attachments"] = AnyCodable(encoded)
        }

        let data = try await GatewayConnection.shared.request(method: "chat.send", params: params)
        return try JSONDecoder().decode(ClawdisChatSendResponse.self, from: data)
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        let data = try await GatewayConnection.shared.request(
            method: "health",
            params: nil,
            timeoutMs: Double(timeoutMs))
        return (try? JSONDecoder().decode(ClawdisGatewayHealthOK.self, from: data))?.ok ?? true
    }

    func events() -> AsyncStream<ClawdisChatTransportEvent> {
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
                    switch push {
                    case let .snapshot(hello):
                        let ok = (try? JSONDecoder().decode(
                            ClawdisGatewayHealthOK.self,
                            from: JSONEncoder().encode(hello.snapshot.health)))?.ok ?? true
                        continuation.yield(.health(ok: ok))
                    case let .event(evt):
                        switch evt.event {
                        case "health":
                            guard let payload = evt.payload else { break }
                            let ok = (try? JSONDecoder().decode(
                                ClawdisGatewayHealthOK.self,
                                from: JSONEncoder().encode(payload)))?.ok ?? true
                            continuation.yield(.health(ok: ok))
                        case "tick":
                            continuation.yield(.tick)
                        case "chat":
                            guard let payload = evt.payload else { break }
                            if let chat = try? JSONDecoder().decode(
                                ClawdisChatEventPayload.self,
                                from: JSONEncoder().encode(payload))
                            {
                                continuation.yield(.chat(chat))
                            }
                        default:
                            break
                        }
                    case .seqGap:
                        continuation.yield(.seqGap)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }
}

// MARK: - Window controller

@MainActor
final class WebChatSwiftUIWindowController {
    private let presentation: WebChatPresentation
    private let sessionKey: String
    private let hosting: NSHostingController<ClawdisChatView>
    private var window: NSWindow?
    private var dismissMonitor: Any?
    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?

    init(sessionKey: String, presentation: WebChatPresentation) {
        self.sessionKey = sessionKey
        self.presentation = presentation
        let vm = ClawdisChatViewModel(sessionKey: sessionKey, transport: MacGatewayChatTransport())
        self.hosting = NSHostingController(rootView: ClawdisChatView(viewModel: vm))
        self.window = Self.makeWindow(for: presentation, contentViewController: self.hosting)
    }

    deinit {}

    var isVisible: Bool {
        self.window?.isVisible ?? false
    }

    func show() {
        guard let window else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func presentAnchored(anchorProvider: () -> NSRect?) {
        guard case .panel = self.presentation, let window else { return }
        self.reposition(using: anchorProvider)
        self.installDismissMonitor()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func close() {
        self.window?.orderOut(nil)
        self.onVisibilityChanged?(false)
        self.onClosed?()
        self.removeDismissMonitor()
    }

    private func reposition(using anchorProvider: () -> NSRect?) {
        guard let window else { return }
        guard let anchor = anchorProvider() else { return }
        let screen = NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(NSPoint(x: anchor.midX, y: anchor.midY))
        } ?? NSScreen.main
        var frame = window.frame
        if let screen {
            let bounds = screen.visibleFrame.insetBy(
                dx: WebChatSwiftUILayout.anchorPadding,
                dy: WebChatSwiftUILayout.anchorPadding)

            let desiredX = round(anchor.midX - frame.width / 2)
            let desiredY = anchor.minY - frame.height - WebChatSwiftUILayout.anchorPadding

            let maxX = bounds.maxX - frame.width
            let maxY = bounds.maxY - frame.height

            frame.origin.x = maxX >= bounds.minX ? min(max(desiredX, bounds.minX), maxX) : bounds.minX
            frame.origin.y = maxY >= bounds.minY ? min(max(desiredY, bounds.minY), maxY) : bounds.minY
        } else {
            frame.origin.x = round(anchor.midX - frame.width / 2)
            frame.origin.y = anchor.minY - frame.height
        }
        window.setFrame(frame, display: false)
    }

    private func installDismissMonitor() {
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
        if let monitor = self.dismissMonitor {
            NSEvent.removeMonitor(monitor)
            self.dismissMonitor = nil
        }
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
            window.title = "Clawdis Chat (SwiftUI)"
            window.contentViewController = contentViewController
            window.isReleasedWhenClosed = false
            window.titleVisibility = .visible
            window.titlebarAppearsTransparent = false
            window.backgroundColor = .windowBackgroundColor
            window.isOpaque = true
            window.center()
            window.minSize = NSSize(width: 880, height: 680)
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
            return panel
        }
    }
}
