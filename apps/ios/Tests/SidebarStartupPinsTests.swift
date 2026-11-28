import OpenClawChatUI
import SwiftUI
import UIKit
import Vision
import XCTest
@testable import OpenClaw

@MainActor
final class SidebarStartupPinsTests: XCTestCase {
    func testDrawerDoesNotExposePartialPinsWhileReconnecting() async throws {
        for scheme: ColorScheme in [.light, .dark] {
            try await self.exerciseDrawer(scheme: scheme)
        }
    }

    private func exerciseDrawer(scheme: ColorScheme) async throws {
        let theme = scheme == .dark ? "dark" : "light"
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
            .environment(\.colorScheme, scheme)
        let host = UIHostingController(rootView: sidebar)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 340, height: 850))
        host.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        window.overrideUserInterfaceStyle = host.overrideUserInterfaceStyle
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        func image() -> UIImage {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            return UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }
        }

        func attach(_ image: UIImage, _ name: String) {
            let attachment = XCTAttachment(image: image)
            attachment.name = "\(theme)-\(name)"
            attachment.lifetime = .keepAlways
            self.add(attachment)
        }

        func labels(in image: UIImage) throws -> [String: CGRect] {
            let request = VNRecognizeTextRequest()
            try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
            var labels: [String: CGRect] = [:]
            for result in request.results ?? [] {
                if let string = result.topCandidates(1).first?.string { labels[string] = result.boundingBox }
            }
            return labels
        }

        await Task.yield()
        XCTAssertNotNil(try labels(in: image())["Atlas"], "Cached conversations remain reachable offline")
        app.apply(.attemptStarted, to: .operator, route: nil)
        await Task.yield()
        let opening = image()
        attach(opening, "opening")
        let openingLabels = try labels(in: opening)
        XCTAssertNil(openingLabels["Atlas"])
        XCTAssertFalse(openingLabels.keys.contains { $0.localizedCaseInsensitiveContains("Loading sessions") })
        func shortcuts(_ image: UIImage) throws -> Data {
            // Include the page controls, not the safe-area chrome. OCR sometimes joins a leading
            // system icon to its label, which says nothing about whether that row moved.
            let source = try XCTUnwrap(image.cgImage)
            let scale = image.scale
            let crop = CGRect(x: 8 * scale, y: 135 * scale, width: 220 * scale, height: 227 * scale)
            let pixels = try XCTUnwrap(source.cropping(to: crop))
            return try XCTUnwrap(UIImage(cgImage: pixels).pngData())
        }
        let openingShortcuts = try shortcuts(opening)

        app.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
        app.personalSidebarPins = IOSSidebarPins(entries: [atlas, archive].map { "session:\($0.key)" })
        await Task.yield()
        XCTAssertNil(try labels(in: image())["Atlas"], "Do not offer just the pin that happens to be in the cache")
        let rows = [inbox, atlas, archive, row("Notes", updated: 4), row("Plans", updated: 5)]
        model.testRosterLoad = { .init(sessions: rows, isCached: false) }
        await model.refresh(appModel: app)
        let start = CACurrentMediaTime()
        var frames: [(Int, UIImage)] = []
        for delay in [20, 45, 90] {
            try await Task.sleep(for: .milliseconds(delay))
            let elapsed = Int((CACurrentMediaTime() - start) * 1000)
            frames.append((elapsed, image()))
        }
        for (elapsed, frame) in frames {
            attach(frame, "fade-\(elapsed)ms")
        }
        try await Task.sleep(for: .milliseconds(100))
        let ready = image()
        attach(ready, "ready")
        let readyLabels = try labels(in: ready)
        let titles = Set(readyLabels.keys.flatMap { $0.split(whereSeparator: { !$0.isLetter }).map(String.init) })
        XCTAssertTrue(titles.isSuperset(of: ["Atlas", "Almanac", "Inbox", "Notes", "Plans"]), "\(titles)")
        XCTAssertTrue(try shortcuts(ready) == openingShortcuts, "The page controls must not move when sessions appear")
        app.apply(.dropped, to: .operator, route: nil)
        await Task.yield()
        XCTAssertNotNil(try labels(in: image())["Atlas"], "Between reconnect attempts, show the cached roster")
    }
}
