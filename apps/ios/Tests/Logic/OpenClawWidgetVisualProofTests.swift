import CoreText
import SwiftUI
import UIKit
import WidgetKit
import XCTest

@MainActor
final class OpenClawWidgetVisualProofTests: XCTestCase {
    private typealias Fixtures = OpenClawWidgetProofFixtures

    func testHomeAndLockFamiliesWithLongLabelsAndDynamicType() throws {
        let revision = try self.revision()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let attachment = try XCTAttachment(
            data: encoder.encode(Fixtures.catalog(revision: revision)), uniformTypeIdentifier: "public.json")
        attachment.name = "widget-catalog-\(revision)"
        attachment.lifetime = .keepAlways
        self.add(attachment)
        var contextCaptures: [String: Pixels] = [:]
        for fixture in Fixtures.all where fixture.group == .longLabel || fixture.group == .context {
            let pixels = try self.capture(fixture)
            if fixture.group == .context {
                contextCaptures[fixture.id] = pixels
            }
        }
        for family in Fixtures.Family.allCases.suffix(3) {
            let release = try XCTUnwrap(contextCaptures["conversation-running-\(family.rawValue)-light-large"])
            let incident = try XCTUnwrap(
                contextCaptures["conversation-running-other-selection-\(family.rawValue)-light-large"])
            XCTAssertFalse(
                release.differenceBounds(from: incident).isNull,
                "Different named conversations must not collapse to the same status symbol")
        }
    }

    func testCompactOfflineAndFactAgeRemainIndependentlyVisible() throws {
        for family in Fixtures.Family.allCases.suffix(3) {
            for appearance in Fixtures.Appearance.allCases {
                var captures: [String: Pixels] = [:]
                for fixture in Fixtures.all where fixture.group == .compact &&
                    fixture.family == family && fixture.appearance == appearance
                {
                    captures[fixture.scenario] = try self.capture(fixture)
                }
                let offline = try XCTUnwrap(captures["offline-recent"])
                let stale = try XCTUnwrap(captures["online-stale"])
                let both = try XCTUnwrap(captures["offline-stale"])
                let unknown = try XCTUnwrap(captures["offline-age-unknown"])
                let staleDifference = both.differenceBounds(from: offline)
                let offlineDifference = both.differenceBounds(from: stale)
                let unknownDifference = unknown.differenceBounds(from: offline)
                XCTAssertFalse(staleDifference.isNull, "Staleness must remain visible while offline")
                XCTAssertFalse(offlineDifference.isNull, "Offline must remain visible while stale")
                XCTAssertFalse(unknownDifference.isNull, "Unknown-age facts must not look recent")
            }
        }
    }

    func testRecoveryAndPrivacyAreExposedWithoutSelectedDetails() throws {
        for family in Fixtures.Family.allCases.suffix(3) {
            var captures: [String: Pixels] = [:]
            for fixture in Fixtures.all where fixture.group == .recovery && fixture.family == family {
                XCTAssertNil(fixture.presentation.kind)
                XCTAssertNil(fixture.presentation.label)
                XCTAssertNil(fixture.presentation.recordedAt)
                captures[fixture.scenario] = try self.capture(fixture)
            }
            for scenario in ["locked", "hidden"] {
                let pixels = try XCTUnwrap(captures[scenario])
                let alternativePixels = try XCTUnwrap(captures["\(scenario)-other-selection"])
                XCTAssertTrue(
                    pixels.differenceBounds(from: alternativePixels).isNull,
                    "Private labels and outcomes must not affect rendered pixels")
            }
        }
    }

    @discardableResult
    private func capture(_ fixture: Fixtures.Fixture) throws -> Pixels {
        try self.registerFonts()
        let family = fixture.family
        let scheme = fixture.appearance.scheme
        let name = try XCTUnwrap(Fixtures.catalog(revision: self.revision())
            .cases.first { $0.id == fixture.id }).name
        let root = OpenClawStatusWidgetContent(presentation: fixture.presentation, family: family.value)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, fixture.textSize.value)
            .environment(\.locale, Fixtures.locale)
            .environment(\.timeZone, Fixtures.timeZone)
        let hosting = UIHostingController(rootView: root)
        hosting.safeAreaRegions = []
        let fitted = hosting.sizeThatFits(in: family.size)
        XCTAssertLessThanOrEqual(fitted.width, family.size.width + 0.5, name)
        XCTAssertLessThanOrEqual(fitted.height, family.size.height + 0.5, name)

        // The unpainted gutter reveals content escaping its allotted canvas.
        let gutter: CGFloat = 8
        let canvas = CGSize(width: family.size.width + gutter * 2, height: family.size.height + gutter * 2)
        let contentFrame = CGRect(origin: CGPoint(x: gutter, y: gutter), size: family.size)
        let container = UIViewController()
        container.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        container.view.backgroundColor = .systemBackground
        let window = UIWindow(frame: CGRect(origin: .zero, size: canvas))
        defer {
            container.beginAppearanceTransition(false, animated: false)
            container.endAppearanceTransition()
            hosting.willMove(toParent: nil)
            hosting.view.removeFromSuperview()
            hosting.removeFromParent()
            window.resignKey()
            window.isHidden = true
            window.rootViewController = nil
        }
        window.rootViewController = container
        container.addChild(hosting)
        container.view.addSubview(hosting.view)
        hosting.view.backgroundColor = .clear
        hosting.view.frame = contentFrame
        hosting.didMove(toParent: container)
        container.beginAppearanceTransition(true, animated: false)
        window.makeKeyAndVisible()
        container.endAppearanceTransition()
        container.view.frame = window.bounds
        container.view.setNeedsLayout()
        container.view.layoutIfNeeded()
        hosting.view.layoutIfNeeded()
        XCTAssertEqual(hosting.view.bounds.size, family.size, name)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        let image = UIGraphicsImageRenderer(size: canvas, format: format).image { context in
            // Hostless tests have no onscreen render-server hierarchy; capture the native layer tree.
            container.view.layer.render(in: context.cgContext)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
        XCTAssertEqual(image.size, canvas, name)
        XCTAssertEqual(image.scale, 1, name)
        let pixels = try Pixels(image: image)
        XCTAssertEqual(pixels.width, Int(canvas.width), name)
        XCTAssertEqual(pixels.height, Int(canvas.height), name)
        self.checkInk(pixels, contentFrame: contentFrame, name: name)

        return pixels
    }

    private func registerFonts() throws {
        for (resource, postScriptName) in [
            ("Inter[opsz,wght]", "Inter-Regular"),
            ("RedHatDisplay[wght]", "RedHatDisplay-Regular"),
        ] {
            guard UIFont(name: postScriptName, size: 12) == nil else { continue }
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: resource, withExtension: "ttf"))
            XCTAssertTrue(CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil))
            XCTAssertNotNil(UIFont(name: postScriptName, size: 12), "Do not silently render with a fallback font")
        }
    }

    private func revision() throws -> String {
        let revision = try XCTUnwrap(Bundle(for: Self.self)
            .object(forInfoDictionaryKey: "OpenClawGitCommit") as? String)
        XCTAssertNotNil(revision.range(of: "^[0-9a-f]{40}$", options: .regularExpression))
        return revision
    }

    private func checkInk(_ pixels: Pixels, contentFrame: CGRect, name: String) {
        var ink = 0
        var escaped = 0
        for y in 0..<pixels.height {
            for x in 0..<pixels.width {
                let offset = (y * pixels.width + x) * 4
                guard (0..<3).contains(where: { abs(Int(pixels.bytes[offset + $0]) - Int(pixels.bytes[$0])) > 8 })
                else { continue }
                ink += 1
                if !contentFrame.contains(CGPoint(x: CGFloat(x) + 0.5, y: CGFloat(y) + 0.5)) {
                    escaped += 1
                }
            }
        }
        XCTAssertGreaterThan(ink, 16, "Blank canvas: \(name)")
        XCTAssertEqual(escaped, 0, "Content escaped the canvas: \(name)")
    }

    private struct Pixels {
        let width: Int
        let height: Int
        let bytes: [UInt8]

        init(image: UIImage) throws {
            let cgImage = try XCTUnwrap(image.cgImage)
            self.width = cgImage.width
            self.height = cgImage.height
            var bytes = [UInt8](repeating: 0, count: cgImage.width * cgImage.height * 4)
            try bytes.withUnsafeMutableBytes { buffer in
                let context = try XCTUnwrap(CGContext(
                    data: buffer.baseAddress,
                    width: cgImage.width,
                    height: cgImage.height,
                    bitsPerComponent: 8,
                    bytesPerRow: cgImage.width * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
            }
            self.bytes = bytes
        }

        func differenceBounds(from other: Self) -> CGRect {
            XCTAssertEqual(self.width, other.width)
            XCTAssertEqual(self.height, other.height)
            guard self.bytes.count == other.bytes.count else { return .null }
            var bounds = CGRect.null
            for y in 0..<self.height {
                for x in 0..<self.width {
                    let offset = (y * self.width + x) * 4
                    if (0..<3)
                        .contains(where: { abs(Int(self.bytes[offset + $0]) - Int(other.bytes[offset + $0])) > 8 })
                    {
                        bounds = bounds.union(CGRect(x: x, y: y, width: 1, height: 1))
                    }
                }
            }
            return bounds
        }
    }
}
