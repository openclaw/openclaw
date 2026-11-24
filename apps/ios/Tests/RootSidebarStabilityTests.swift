import OpenClawChatUI
import OpenClawProtocol
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct RootSidebarStabilityTests {
    @Test func `roster insertion above viewport preserves the visible rows`() async {
        let appModel = NodeAppModel()
        let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let model = RootSidebarModel()
        // 40 pinned rows, then 23 recent rows of which the sidebar shows the newest 20.
        var sessions = (0..<63).map { index in
            var row = OpenClawChatSessionEntry(
                key: "agent:main:work-\(index)", kind: "direct", updatedAt: Double(index),
                sessionId: "work-\(index)", label: "Work \(index)")
            row.pinned = index < 40
            return row
        }
        model.testRosterLoad = { ChatSessionRosterSnapshot(sessions: sessions, isCached: false) }
        await model.refreshSessions(appModel: appModel)
        let root = RootSidebar(
            model: model, selectedDestination: .chat, isDrawerLayout: true,
            isDismissButtonEnabled: true, selectDestination: { _ in }, selectSession: { _ in }, hideSidebar: {})
            .environment(appModel)
            .environment(gatewayController)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 340, height: 700))
        let host = UIHostingController(rootView: root)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        await Self.settle(host.view)
        guard let scroll = Self.scrollView(in: host.view) else {
            Issue.record("Sidebar scroll view not mounted")
            return
        }
        scroll.setContentOffset(CGPoint(x: 0, y: 400), animated: false)
        await Self.settle(host.view)
        let oldOffset = scroll.contentOffset.y
        for index in 63..<66 {
            var row = OpenClawChatSessionEntry(
                key: "agent:main:work-\(index)", kind: "direct", updatedAt: Double(index),
                sessionId: "work-\(index)", label: "Work \(index)")
            row.pinned = true
            sessions.append(row)
        }
        await model.refreshSessions(appModel: appModel)
        await Self.settle(host.view)
        // This fixture inserts three 44-point rows with 2-point stack spacing.
        // Lazy contentSize is an estimate, not a valid insertion-height oracle.
        let insertedRowHeight: CGFloat = 3 * (44 + 2)
        #expect(
            abs(scroll.contentOffset.y - oldOffset - insertedRowHeight) < 2,
            "The scroll offset must compensate for the three inserted rows")

        // The recent list is capped, so rows arriving above push rows out below; compensation must stop at the end.
        scroll.setContentOffset(CGPoint(x: 0, y: Self.maxOffset(scroll)), animated: false)
        await Self.settle(host.view)
        for index in 66..<69 {
            sessions.append(OpenClawChatSessionEntry(
                key: "agent:main:work-\(index)", kind: "direct", updatedAt: Double(index),
                sessionId: "work-\(index)", label: "Work \(index)"))
        }
        await model.refreshSessions(appModel: appModel)
        await Self.settle(host.view)
        #expect(scroll.contentOffset.y <= Self.maxOffset(scroll) + 1, "Compensation must stop at the end of the list")
    }

    private static func maxOffset(_ scroll: UIScrollView) -> CGFloat {
        max(0, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
    }

    private static func settle(_ view: UIView) async {
        for _ in 0..<20 {
            view.setNeedsLayout()
            view.layoutIfNeeded()
            await Task.yield()
        }
    }

    private static func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        return view.subviews.lazy.compactMap { self.scrollView(in: $0) }.first
    }
}
