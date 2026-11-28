@testable import OpenClaw
import OpenClawChatUI
import SwiftUI
import UIKit
import Vision
import XCTest

@MainActor
final class SidebarStartupPinsTests: XCTestCase {
    func testDrawerDoesNotExposePartialPinsWhileReconnecting() async throws {
        for scheme: ColorScheme in [.light, .dark] {
            try await exerciseDrawer(scheme: scheme)
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
            openSearch: {}
        )
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
            add(attachment)
        }

        await Task.yield()
        XCTAssertNotNil(try Self.labels(in: image())["Atlas"], "Cached conversations remain reachable offline")
        app.apply(.attemptStarted, to: .operator, route: nil)
        await Task.yield()
        let opening = image()
        attach(opening, "opening")
        let openingLabels = try Self.labels(in: opening)
        XCTAssertNil(openingLabels["Atlas"])
        XCTAssertFalse(openingLabels.keys.contains { $0.localizedCaseInsensitiveContains("Loading sessions") })
        let pinnedHeading = try XCTUnwrap(Self.heading("Pinned", in: openingLabels), "\(openingLabels.keys)")
        let sessionsHeading = try XCTUnwrap(Self.heading("Sessions", in: openingLabels), "\(openingLabels.keys)")
        let openingShortcuts = try Self.shortcuts(opening)

        app.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
        let drafts = row("Drafts", updated: 0.5)
        app.personalSidebarPins = IOSSidebarPins(entries: [atlas, archive, drafts].map { "session:\($0.key)" })
        await Task.yield()
        XCTAssertNil(try Self.labels(in: image())["Atlas"], "Do not offer just the pin that happens to be in the cache")
        let rows = [inbox, atlas, archive, drafts] + [("Notes", 4.0), ("Plans", 5), ("Recipes", 6)].map(row)
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
        let readyLabels = try Self.labels(in: ready)
        let titles = Self.words(in: readyLabels)
        let expected: Set = ["Atlas", "Almanac", "Drafts", "Inbox", "Notes", "Plans", "Recipes"]
        XCTAssertTrue(titles.isSuperset(of: expected), "\(titles)")
        // The loading state shows the same headings in the same places, so nothing above a row moves.
        for (title, before) in [("Pinned", pinnedHeading), ("Sessions", sessionsHeading)] {
            let after = try XCTUnwrap(Self.heading(title, in: readyLabels))
            XCTAssertEqual(after.midY, before.midY, accuracy: 0.002, title)
        }
        XCTAssertTrue(try Self.shortcuts(ready) == openingShortcuts, "Page controls must not move when sessions appear")
        app.apply(.dropped, to: .operator, route: nil)
        try await Task.sleep(for: .milliseconds(300))
        let dropped = image()
        attach(dropped, "dropped")
        XCTAssertTrue(
            try Self.words(in: Self.labels(in: dropped)).contains("Atlas"),
            "Between reconnect attempts, show the cached roster"
        )
    }

    private static func labels(in image: UIImage) throws -> [String: CGRect] {
        let request = VNRecognizeTextRequest()
        try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
        var labels: [String: CGRect] = [:]
        for result in request.results ?? [] {
            if let string = result.topCandidates(1).first?.string {
                labels[string] = result.boundingBox
            }
        }
        return labels
    }

    private static func words(in labels: [String: CGRect]) -> Set<String> {
        Set(labels.keys.flatMap { $0.split(whereSeparator: { !$0.isLetter }).map(String.init) })
    }

    /// A section heading sits at the text inset, left of the page labels that follow their icons.
    private static func heading(_ title: String, in labels: [String: CGRect]) -> CGRect? {
        labels.first { $0.key.hasPrefix(title) && $0.value.minX < 0.1 }?.value
    }

    /// The page controls, not the safe-area chrome. OCR sometimes joins a leading system icon to its
    /// label, which says nothing about whether that row moved, so compare pixels.
    private static func shortcuts(_ image: UIImage) throws -> Data {
        let source = try XCTUnwrap(image.cgImage)
        let scale = image.scale
        let crop = CGRect(x: 8 * scale, y: 135 * scale, width: 220 * scale, height: 227 * scale)
        let pixels = try XCTUnwrap(source.cropping(to: crop))
        return try XCTUnwrap(UIImage(cgImage: pixels).pngData())
    }
}
