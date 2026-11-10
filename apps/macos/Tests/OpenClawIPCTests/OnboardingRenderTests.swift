import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

/// Opt-in bitmap evidence. Run only under the native render sandbox, never the app entry point.
@MainActor
struct OnboardingRenderTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `native onboarding pages render`() throws {
        let output = try Self.outputDirectory()
        let before = ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_BEFORE"] == "1"
        let state = AppState(preview: true)
        state.connectionMode = .local
        state.isPaused = true
        let view = OnboardingView(state: state, gatewaySelectionPersister: { true }, dashboardHandoffOpener: { _ in })
        let pages = before ? [(1, "where"), (9, "done")] : [
            (1, "where"), (2, "getting-ready"), (3, "connect-ai"),
            (4, "find"), (5, "reach"), (9, "done-local"),
        ]
        for (page, name) in pages {
            try Self.capture(
                view.pageView(for: page, contentHeight: 535),
                name: name,
                label: "Native UI · isolated preview state · no live connection",
                output: output)
        }
        state.connectionMode = .unconfigured
        try Self.capture(
            view.pageView(for: 9, contentHeight: 535),
            name: "done-later",
            label: "Native UI · Set up later · isolated preview state",
            output: output)
    }

    static func outputDirectory() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        let output = try URL(fileURLWithPath: #require(environment["OPENCLAW_ONBOARDING_RENDER_DIR"]))
        let canary = try #require(environment["OPENCLAW_ONBOARDING_DENIED_FILE"])
        try #require((try? Data(contentsOf: URL(fileURLWithPath: canary))) == nil)
        let home = try #require(environment["CFFIXED_USER_HOME"])
        try #require(NSHomeDirectory() == home)
        return output
    }

    static func capture(_ content: some View, name: String, label: String, output: URL) throws {
        for dark in [false, true] {
            let hosting = NSHostingView(rootView: VStack(spacing: 0) {
                Text(label).font(.caption).foregroundStyle(.secondary).padding(10)
                GlowingOpenClawIcon(size: 110).frame(height: 125)
                content.frame(width: 630, height: 535)
                Spacer(minLength: 0)
            }
            .frame(width: 630, height: 752)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.locale, Locale(identifier: "en_US"))
            .environment(\.colorScheme, dark ? .dark : .light))
            hosting.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            hosting.frame = NSRect(x: 0, y: 0, width: 630, height: 752)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = hosting
            defer {
                window.contentView = nil
                window.close()
            }
            hosting.layoutSubtreeIfNeeded()
            let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: output.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png"))
        }
    }
}
