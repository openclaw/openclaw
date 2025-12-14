import AppKit
import Foundation
import Testing
@testable import Clawdis

@Suite(.serialized)
@MainActor
struct WebChatWindowSmokeTests {
    private struct DefaultsSnapshot {
        var connectionMode: Any?
        var webChatPort: Any?
        var webChatEnabled: Any?
        var webChatSwiftUIEnabled: Any?

        init() {
            let d = UserDefaults.standard
            self.connectionMode = d.object(forKey: connectionModeKey)
            self.webChatPort = d.object(forKey: webChatPortKey)
            self.webChatEnabled = d.object(forKey: webChatEnabledKey)
            self.webChatSwiftUIEnabled = d.object(forKey: webChatSwiftUIEnabledKey)
        }

        func restore() {
            let d = UserDefaults.standard
            if let connectionMode { d.set(connectionMode, forKey: connectionModeKey) } else { d.removeObject(forKey: connectionModeKey) }
            if let webChatPort { d.set(webChatPort, forKey: webChatPortKey) } else { d.removeObject(forKey: webChatPortKey) }
            if let webChatEnabled { d.set(webChatEnabled, forKey: webChatEnabledKey) } else { d.removeObject(forKey: webChatEnabledKey) }
            if let webChatSwiftUIEnabled { d.set(webChatSwiftUIEnabled, forKey: webChatSwiftUIEnabledKey) } else { d.removeObject(forKey: webChatSwiftUIEnabledKey) }
        }
    }

    private func waitForBaseURL(server: WebChatServer, timeoutSeconds: TimeInterval = 2.0) async throws -> URL {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let url = server.baseURL() { return url }
            try await Task.sleep(nanoseconds: 25_000_000) // 25ms
        }
        throw NSError(domain: "WebChatWindowSmokeTests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "server did not become ready",
        ])
    }

    private func makeLocalHTTPServerWithIndex(booted: Bool) async throws -> (server: WebChatServer, port: Int, root: URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("clawdis-webchat-win-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let html = booted
            ? "<html><body><div id='app' data-booted='1'></div></body></html>"
            : "<html><body><div id='app'></div></body></html>"
        try Data(html.utf8).write(to: root.appendingPathComponent("index.html"))

        let server = WebChatServer()
        server.start(root: root, preferredPort: nil)
        let base = try await waitForBaseURL(server: server)
        guard let port = base.port else {
            throw NSError(domain: "WebChatWindowSmokeTests", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "server baseURL missing port",
            ])
        }
        return (server: server, port: port, root: root)
    }

    @Test func windowControllerBootstrapsInLocalModeWhenReachable() async throws {
        let snapshot = DefaultsSnapshot()
        defer { snapshot.restore() }

        let serverInfo = try await makeLocalHTTPServerWithIndex(booted: true)
        defer {
            serverInfo.server.stop()
            try? FileManager.default.removeItem(at: serverInfo.root)
        }

        let d = UserDefaults.standard
        d.set("local", forKey: connectionModeKey)
        d.set(true, forKey: webChatEnabledKey)
        d.set(serverInfo.port, forKey: webChatPortKey)
        d.set(false, forKey: webChatSwiftUIEnabledKey)

        let controller = WebChatWindowController(sessionKey: "main", presentation: .window)
        try await Task.sleep(nanoseconds: 150_000_000) // allow bootstrap + reachability
        controller.shutdown()
        controller.close()
    }

    @Test func panelControllerCanPresentAndDismiss() async throws {
        let snapshot = DefaultsSnapshot()
        defer { snapshot.restore() }

        let serverInfo = try await makeLocalHTTPServerWithIndex(booted: true)
        defer {
            serverInfo.server.stop()
            try? FileManager.default.removeItem(at: serverInfo.root)
        }

        let d = UserDefaults.standard
        d.set("local", forKey: connectionModeKey)
        d.set(true, forKey: webChatEnabledKey)
        d.set(serverInfo.port, forKey: webChatPortKey)

        let controller = WebChatWindowController(
            sessionKey: "main",
            presentation: .panel(anchorProvider: { NSRect(x: 200, y: 400, width: 40, height: 40) }))

        controller.presentAnchoredPanel(anchorProvider: { NSRect(x: 200, y: 400, width: 40, height: 40) })
        controller.windowDidResignKey(Notification(name: NSWindow.didResignKeyNotification))
        controller.windowWillClose(Notification(name: NSWindow.willCloseNotification))
        controller.shutdown()
        controller.close()
    }

    @Test func managerShowAndTogglePanelDoNotCrash() async throws {
        let snapshot = DefaultsSnapshot()
        defer { snapshot.restore() }

        let serverInfo = try await makeLocalHTTPServerWithIndex(booted: true)
        defer {
            serverInfo.server.stop()
            try? FileManager.default.removeItem(at: serverInfo.root)
        }

        let d = UserDefaults.standard
        d.set("local", forKey: connectionModeKey)
        d.set(true, forKey: webChatEnabledKey)
        d.set(false, forKey: webChatSwiftUIEnabledKey)
        d.set(serverInfo.port, forKey: webChatPortKey)

        WebChatManager.shared.resetTunnels()
        WebChatManager.shared.show(sessionKey: "main")
        WebChatManager.shared.togglePanel(sessionKey: "main", anchorProvider: { NSRect(x: 220, y: 380, width: 20, height: 20) })
        WebChatManager.shared.togglePanel(sessionKey: "main", anchorProvider: { NSRect(x: 220, y: 380, width: 20, height: 20) })
        WebChatManager.shared.close()
    }
}

