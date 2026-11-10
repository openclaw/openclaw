import AppKit
import Foundation
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct DebugSettingsPortStatusTests {
    @Test func `successful kill feedback survives the listener refresh`() async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let listener = Process()
        listener.executableURL = URL(fileURLWithPath: "/usr/bin/nc")
        listener.arguments = ["-l", "127.0.0.1", "0"]
        listener.standardInput = Pipe()
        listener.standardOutput = FileHandle.nullDevice
        listener.standardError = FileHandle.nullDevice
        try listener.run()
        defer {
            if listener.isRunning { listener.terminate() }
            listener.waitUntilExit()
        }
        let pid = listener.processIdentifier
        var listeningPort: Int?
        try await TestWait.state("owned listener readiness") {
            try #require(listener.isRunning)
            let result = await ShellExecutor.run(
                command: ["/usr/sbin/lsof", "-a", "-p", "\(pid)", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"],
                cwd: nil,
                env: nil,
                timeout: 2)
            if let data = result.payload, let output = String(data: data, encoding: .utf8) {
                listeningPort = output.split(separator: "\n")
                    .first { $0.hasPrefix("n127.0.0.1:") }
                    .flatMap { Int($0.dropFirst("n127.0.0.1:".count)) }
            }
            return listeningPort != nil
        }
        let port = try #require(listeningPort)
        let config = root.appendingPathComponent("openclaw.json")
        try JSONSerialization.data(withJSONObject: ["gateway": ["mode": "local", "port": port]])
            .write(to: config)
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": config.path]) {
            _ = AppKitTestSupport.application
            let hosting = NSHostingView(rootView: DebugSettings(state: AppState(preview: true))
                .environment(\.locale, Locale(identifier: "en_US")))
            hosting.frame = NSRect(x: 0, y: 0, width: 1000, height: 900)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = hosting
            defer {
                window.orderOut(nil)
                window.contentView = nil
                window.close()
            }
            window.orderFront(nil)
            hosting.layoutSubtreeIfNeeded()
            let check = try await Self.button("Check gateway ports", in: window)
            #expect(check.accessibilityPerformPress?() == true)
            _ = try await AppKitTestSupport.waitForAccessibilityElement(
                in: window, description: "owned listener PID \(pid)")
            { elements in
                elements.first { Self.text(of: $0)?.contains("(\(pid))") == true }
            }
            let kill = try await Self.button("Kill", in: window)
            Self.scrollTo(kill, in: hosting, window: window)
            #expect(kill.accessibilityPerformPress?() == true)
            _ = try await AppKitTestSupport.waitForAccessibilityElement(
                in: window, description: "refreshed empty listener list")
            { elements in
                elements.first { Self.text(of: $0)?.contains("Nothing is listening on \(port)") == true }
            }
            try #require(await TestProcessSupport.waitUntilGone(pid))
            Self.scrollTo(check, in: hosting, window: window)
            let elements = try await AppKitTestSupport.accessibilityElements(in: hosting)
            #expect(elements.contains { Self.text(of: $0) == "Sent kill to \(pid)." })
        }
    }

    private static func button(_ title: String, in window: NSWindow) async throws -> AnyObject {
        try await AppKitTestSupport.waitForAccessibilityElement(in: window, description: title) { elements in
            elements.first {
                $0.accessibilityRole?() == .button && AppKitTestSupport.accessibilityName(of: $0) == title
            }
        }
    }

    private static func scrollTo(_ element: AnyObject, in hosting: NSView, window: NSWindow) {
        guard let frame = element.accessibilityFrame?() else { return }
        var views = [hosting]
        var scrolls: [NSScrollView] = []
        while let view = views.popLast() {
            views.append(contentsOf: view.subviews)
            if let scroll = view as? NSScrollView { scrolls.append(scroll) }
        }
        if let document = scrolls.max(by: {
            ($0.documentView?.bounds.height ?? 0) < ($1.documentView?.bounds.height ?? 0)
        })?.documentView {
            document.scrollToVisible(document.convert(window.convertFromScreen(frame), from: nil))
        }
        hosting.layoutSubtreeIfNeeded()
    }

    private static func text(of element: AnyObject) -> String? {
        if let name = AppKitTestSupport.accessibilityName(of: element) { return name }
        let selector = NSSelectorFromString("accessibilityValue")
        guard let object = element as? NSObject, object.responds(to: selector) else { return nil }
        return object.perform(selector)?.takeUnretainedValue() as? String
    }
}
