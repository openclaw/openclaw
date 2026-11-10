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
            try Self.capturePage(
                view.pageView(for: page, contentHeight: OnboardingView.contentHeight(for: OnboardingView.windowHeight)),
                name: name,
                label: "Native page · default window size · navigation omitted · no live connection",
                output: output)
        }
        state.connectionMode = .unconfigured
        try Self.capturePage(
            view.pageView(for: 9, contentHeight: OnboardingView.contentHeight(for: OnboardingView.windowHeight)),
            name: "done-later",
            label: "Native page · Set up later · default window size · navigation omitted",
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

    static func capturePage(_ content: some View, name: String, label: String, output: URL) throws {
        // Match OnboardingView's default content rectangle and mascot metrics.
        // Leave navigation's space empty rather than fabricate an active route or verified AI state.
        try Self.capture(
            VStack(spacing: 0) {
                GlowingOpenClawIcon(size: 130).offset(y: 10).frame(height: 145)
                content.frame(
                    width: OnboardingView.windowWidth,
                    height: OnboardingView.contentHeight(for: OnboardingView.windowHeight))
                Spacer(minLength: 0)
            }
            .frame(width: OnboardingView.windowWidth, height: OnboardingView.windowHeight),
            name: name, label: label, output: output)
    }

    static func capture(
        _ content: some View,
        name: String,
        label: String,
        output: URL,
        width: CGFloat = OnboardingView.windowWidth,
        dark: Bool? = nil) throws
    {
        for dark in dark.map({ [$0] }) ?? [false, true] {
            let hosting = NSHostingView(rootView: VStack(spacing: 0) {
                content
                Divider()
                Text(label).font(.caption).foregroundStyle(.secondary).padding(10)
            }
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.locale, Locale(identifier: "en_US"))
            .environment(\.colorScheme, dark ? .dark : .light))
            hosting.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            hosting.setFrameSize(hosting.fittingSize)
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
