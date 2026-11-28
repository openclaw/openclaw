import OpenClawChatUI
import SwiftUI
import UIKit
import Vision
import XCTest
@testable import OpenClaw

@MainActor
final class SidebarStartupPinsTests: XCTestCase {
    func testDrawerDoesNotExposePartialPinsWhileReconnecting() async throws {
        let app = NodeAppModel()
        let controller = GatewayConnectionController(appModel: app, startDiscovery: false)
        let model = RootSidebarModel()
        func row(_ name: String, updated: Double) -> OpenClawChatSessionEntry {
            let key = "agent:main:\(name.lowercased())"
            return .init(key: key, kind: "direct", updatedAt: updated, sessionId: key, label: name)
        }
        let atlas = row("Atlas", updated: 2), archive = row("Almanac", updated: 1), inbox = row("Inbox", updated: 3)
        model.applyRoster(.init(sessions: [inbox, atlas], isCached: true, isComplete: false))
        let suite = "SidebarStartupPinsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let sidebar = RootSidebar(
            model: model,
            selectedDestination: .chat,
            isSidebarVisible: true,
            selectDestination: { _ in },
            selectSession: { _ in },
            openPagesEditor: {},
            openSearch: {})
            .environment(app).environment(controller).defaultAppStorage(defaults)
            .transaction { $0.disablesAnimations = true }
        let host = UIHostingController(rootView: sidebar)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 340, height: 850))
        window.overrideUserInterfaceStyle = .dark
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        func capture(_ name: String) async throws -> Set<String> {
            await Task.yield()
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
            let request = VNRecognizeTextRequest()
            try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
            return Set((request.results ?? []).compactMap { $0.topCandidates(1).first?.string })
        }

        let offline = try await capture("offline-cache")
        XCTAssertTrue(offline.contains("Atlas"), "Cached conversations remain reachable offline")
        app.apply(.attemptStarted, to: .operator, route: nil)
        let opening = try await capture("opening-drawer")
        XCTAssertFalse(opening.contains("Atlas"), "Do not offer a cached pin as an ordinary session during startup")
        app.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
        app.personalSidebarPins = IOSSidebarPins(entries: [atlas, archive].map { "session:\($0.key)" })
        let pending = try await capture("placements-before-roster")
        XCTAssertFalse(pending.contains("Atlas"), "Do not offer just the pin that happens to be in the cache")
        model.testRosterLoad = { .init(sessions: [inbox, atlas, archive], isCached: false) }
        await model.refresh(appModel: app)
        let ready = try await capture("complete-roster")
        XCTAssertTrue(
            ready.isSuperset(of: ["Atlas", "Almanac", "Inbox"]),
            "Expected both pins and recent chats: \(ready)")
    }
}
