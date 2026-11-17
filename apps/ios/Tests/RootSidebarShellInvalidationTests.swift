import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct RootSidebarShellInvalidationTests {
    private final class Counter {
        var detail = 0
        var sidebar = 0
    }

    /// Reads environment values, like the chat view.
    private struct Detail: View {
        @Environment(\.scenePhase) private var scenePhase
        @Environment(\.horizontalSizeClass) private var horizontalSizeClass
        let counter: Counter

        var body: some View {
            let _ = self.counter.detail += 1
            Text(verbatim: "detail")
        }
    }

    /// Holds focus and stored state, like the sidebar.
    private struct Sidebar: View {
        @FocusState private var isFocused: Bool
        @AppStorage("RootSidebarShellInvalidationTests.probe") private var stored = ""
        let counter: Counter

        var body: some View {
            let _ = self.counter.sidebar += 1
            Text(verbatim: "sidebar")
        }
    }

    private struct Harness: View {
        let presentation: RootSidebarPresentation
        let counter: Counter

        var body: some View {
            RootSidebarShell(
                sidebarWidth: 316,
                isDrawerLayout: true,
                presentation: self.presentation,
                canOpenFromEdge: true,
                reduceMotion: false,
                animation: nil,
                onShow: {},
                onHide: {},
                sidebar: Sidebar(counter: self.counter),
                detail: Detail(counter: self.counter),
                contentSafeAreaInsets: .init())
        }
    }

    /// A toggle that re-evaluated the shell re-ran the chat, composer and sidebar before
    /// the drawer animation could start (about 115 ms per toggle on an iPhone 16 Pro).
    @Test func `toggling the drawer does not re-evaluate the sidebar or detail`() {
        let counter = Counter()
        let presentation = RootSidebarPresentation(isPresented: false)
        let host = UIHostingController(rootView: Harness(presentation: presentation, counter: counter))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        host.view.layoutIfNeeded()
        CATransaction.flush()
        let initialDetail = counter.detail
        let initialSidebar = counter.sidebar

        for isPresented in [true, false, true, false] {
            presentation.isPresented = isPresented
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            CATransaction.flush()
        }

        #expect(counter.detail == initialDetail)
        #expect(counter.sidebar == initialSidebar)
    }
}
