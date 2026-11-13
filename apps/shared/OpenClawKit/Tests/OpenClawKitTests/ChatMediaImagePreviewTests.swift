import CoreGraphics
import SwiftUI
import Testing
@testable import OpenClawChatUI

#if os(iOS)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

@Suite("Chat image preview")
@MainActor
struct ChatMediaImagePreviewTests {
    @Test(arguments: [
        (CGSize(width: 1170, height: 2532), CGSize(width: 393, height: 852), CGFloat(393.0 / 1170.0)),
        (CGSize(width: 4000, height: 1000), CGSize(width: 393, height: 852), CGFloat(393.0 / 4000.0)),
        (CGSize(width: 1000, height: 4000), CGSize(width: 393, height: 852), CGFloat(852.0 / 4000.0)),
        (CGSize(width: 120, height: 80), CGSize(width: 393, height: 852), CGFloat(1)),
        (CGSize.zero, CGSize(width: 393, height: 852), CGFloat(1)),
    ])
    func `fit scale keeps the whole image visible without upscaling`(
        image: CGSize,
        bounds: CGSize,
        expected: CGFloat)
    {
        let scale = ChatImagePreviewLayout.fitScale(imageSize: image, boundsSize: bounds)
        #expect(abs(scale - expected) < 0.0001)
        #expect(image.width * scale <= bounds.width + 0.001)
        #expect(image.height * scale <= bounds.height + 0.001)
    }

    #if os(iOS) || os(macOS)
    @Test func `close button hit target is at least 44 points`() {
        let button = ChatImagePreviewCloseButton {}
        #if os(iOS)
        let size = UIHostingController(rootView: button).sizeThatFits(in: CGSize(width: 1000, height: 1000))
        #else
        let size = NSHostingController(rootView: button).sizeThatFits(in: CGSize(width: 1000, height: 1000))
        #endif
        #expect(size.width >= 44)
        #expect(size.height >= 44)
    }
    #endif

    #if os(iOS)
    @Test func `zoom view opens fitted inside the safe area with pinch range`() {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1170, height: 2532), format: format).image { context in
            UIColor(white: 0.5, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1170, height: 2532))
        }
        let view = ChatZoomableImageScrollView(image: image)
        view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        view.viewportInsets = UIEdgeInsets(top: 62, left: 0, bottom: 34, right: 0)
        view.layoutIfNeeded()

        let viewport = CGRect(origin: .zero, size: view.bounds.size).inset(by: view.viewportInsets)
        let fit = ChatImagePreviewLayout.fitScale(imageSize: image.size, boundsSize: viewport.size)
        #expect(fit < 1)
        #expect(abs(view.zoomScale - fit) < 0.0001)
        #expect(view.minimumZoomScale == fit)
        #expect(view.maximumZoomScale == fit * ChatImagePreviewLayout.maximumZoomMultiplier)
        // Image frame in the viewport's coordinate space (bounds origin is the content offset).
        let frame = view.convert(view.imageView.bounds, from: view.imageView)
            .offsetBy(dx: -view.bounds.minX, dy: -view.bounds.minY)
        #expect(viewport.insetBy(dx: -0.5, dy: -0.5).contains(frame))
        #expect(abs(frame.midX - viewport.midX) < 1)
        #expect(abs(frame.midY - viewport.midY) < 1)
    }

    @Test func `rotation keeps a zoomed image zoomed and a fitted image fitted`() {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1170, height: 2532), format: format).image { context in
            UIColor(white: 0.5, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1170, height: 2532))
        }
        let fitted = ChatZoomableImageScrollView(image: image)
        fitted.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        fitted.layoutIfNeeded()
        let zoomed = ChatZoomableImageScrollView(image: image)
        zoomed.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        zoomed.layoutIfNeeded()
        zoomed.zoomScale = zoomed.minimumZoomScale * 2

        for view in [fitted, zoomed] {
            view.frame = CGRect(x: 0, y: 0, width: 874, height: 402)
            view.layoutIfNeeded()
            let fit = ChatImagePreviewLayout.fitScale(imageSize: image.size, boundsSize: view.bounds.size)
            #expect(abs(view.minimumZoomScale - fit) < 0.0001)
            #expect(view.maximumZoomScale >= view.minimumZoomScale)
        }
        #expect(abs(fitted.zoomScale - fitted.minimumZoomScale) < 0.0001)
        #expect(abs(zoomed.zoomScale - zoomed.minimumZoomScale * 2) < 0.0001)
    }
    // Diagnostic only: a real UIKit owner, synthetic pixels, and a fixed image-space target.
    // The no-resize argument is a green fixture control; neither argument uses a Gateway.
    @Test(arguments: [false, true])
    func rotationPreservesPannedImageFocalPoint(rotate: Bool) throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1000, height: 1000), format: format)
            .image { context in
                UIColor.gray.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 1000, height: 1000))
            }
        let view = ChatZoomableImageScrollView(image: image)
        // Coordinate conversion requires a shared window; never take over the key window.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1000, height: 1000))
        window.addSubview(view)
        defer {
            view.removeFromSuperview()
            window.isHidden = true
        }
        try #require(view.window === window && view.imageView.window === window)
        view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        view.layoutIfNeeded()
        view.setZoomScale(view.minimumZoomScale * 3, animated: false)
        view.layoutIfNeeded()

        // This image remains larger than both viewports, so edge clamping cannot excuse a jump.
        let expected = CGPoint(x: 400, y: 600)
        let target = view.convert(expected, from: view.imageView)
        view.contentOffset = CGPoint(
            x: target.x - view.bounds.width / 2,
            y: target.y - view.bounds.height / 2)
        view.layoutIfNeeded()
        let before = view.convert(
            CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: view.imageView)
        try #require(
            abs(before.x - expected.x) < 0.5 && abs(before.y - expected.y) < 0.5,
            "Fixture must center the independent image-space target before resizing")

        if rotate {
            view.frame = CGRect(x: 0, y: 0, width: 874, height: 402)
            view.setNeedsLayout()
            view.layoutIfNeeded()
        }
        let after = view.convert(
            CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: view.imageView)
        let matches = abs(after.x - expected.x) < 0.5 && abs(after.y - expected.y) < 0.5
        print(
            "PR191872_FOCAL_POINT rotate=", rotate, "matches=", matches,
            "before=", before.x, before.y, "after=", after.x, after.y,
            "expected=", expected.x, expected.y)
        #expect(matches, "Resizing must preserve the previously centered image point when unclamped")
    }

    @Test(arguments: [false, true], [(false, 400.0), (false, 600.0), (true, 400.0), (true, 600.0)])
    func successiveRefitsPreserveCurrentPannedFocalPoint(resizeBounds: Bool, scenario: (Bool, Double)) throws {
        let (insetsBeforeLayout, initialX) = scenario
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1000, height: 1000), format: format)
            .image { context in
                UIColor.gray.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 1000, height: 1000))
            }
        let view = ChatZoomableImageScrollView(image: image)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1000, height: 1000))
        window.addSubview(view)
        defer { view.removeFromSuperview() }
        try #require(view.window === window && view.imageView.window === window)
        view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        view.layoutIfNeeded()
        view.setZoomScale(view.minimumZoomScale * 3, animated: false)
        view.layoutIfNeeded()

        let sizes = [
            CGSize(width: 874, height: 402),
            CGSize(width: 500, height: 700),
            CGSize(width: 402, height: 874),
        ]
        for (index, size) in sizes.enumerated() {
            let relativeZoom: CGFloat = index == 1 ? 3.5 : 3
            view.setZoomScale(view.minimumZoomScale * relativeZoom, animated: false)
            view.layoutIfNeeded()
            // Pan again after each refit so stale saved offsets cannot satisfy the oracle.
            // The (600, 600) start also detects UIKit clamping the old offset before refit.
            let expected = CGPoint(
                x: CGFloat(initialX) + CGFloat(index) * (initialX == 600 ? -25 : 25),
                y: 600 - CGFloat(index) * 25)
            let target = view.convert(expected, from: view.imageView)
            view.contentOffset = CGPoint(
                x: target.x - view.bounds.width / 2,
                y: target.y - view.bounds.height / 2)
            view.layoutIfNeeded()
            let before = view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: view.imageView)
            try #require(abs(before.x - expected.x) < 0.5 && abs(before.y - expected.y) < 0.5)

            if resizeBounds {
                view.bounds.size = size
            } else {
                view.frame.size = size
            }
            // SwiftUI can update safe-area inputs before or after UIKit's resize layout.
            if insetsBeforeLayout {
                view.viewportInsets = UIEdgeInsets(top: CGFloat(index + 1) * 4, left: 8, bottom: 8, right: 4)
            }
            view.setNeedsLayout()
            view.layoutIfNeeded()
            if !insetsBeforeLayout {
                view.viewportInsets = UIEdgeInsets(top: CGFloat(index + 1) * 4, left: 8, bottom: 8, right: 4)
                view.layoutIfNeeded()
            }
            view.fitImage() // A same-size refit must not replay the previous resize.
            let after = view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: view.imageView)
            #expect(abs(after.x - expected.x) < 0.5 && abs(after.y - expected.y) < 0.5)
            #expect(abs(view.zoomScale / view.minimumZoomScale - relativeZoom) < 0.0001)
        }
    }

    @Test(arguments: [false, true])
    func queuedResizesConsumeAnchorOnce(resizeBounds: Bool) throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1000, height: 1000), format: format)
            .image { context in
                UIColor.gray.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 1000, height: 1000))
            }
        let view = ChatZoomableImageScrollView(image: image)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1000, height: 1000))
        window.addSubview(view)
        defer { view.removeFromSuperview() }
        try #require(view.window === window && view.imageView.window === window)
        let originalSize = CGSize(width: 402, height: 874)
        view.frame.size = originalSize
        view.layoutIfNeeded()
        view.setZoomScale(view.minimumZoomScale * 3, animated: false)
        view.layoutIfNeeded()

        // The first widening can clamp; returning to the fitted size must still refit.
        // A subsequent pan and same-size refit must not replay that first anchor.
        for expected in [CGPoint(x: 600, y: 600), CGPoint(x: 450, y: 550)] {
            let target = view.convert(expected, from: view.imageView)
            view.contentOffset = CGPoint(
                x: target.x - view.bounds.width / 2, y: target.y - view.bounds.height / 2)
            view.layoutIfNeeded()
            let before = view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: view.imageView)
            try #require(abs(before.x - expected.x) < 0.5 && abs(before.y - expected.y) < 0.5)
            if expected.x == 600 {
                if resizeBounds {
                    view.bounds.size = CGSize(width: 874, height: 402)
                    view.bounds.size = originalSize
                } else {
                    view.frame.size = CGSize(width: 874, height: 402)
                    view.frame.size = originalSize
                }
                view.setNeedsLayout()
                view.layoutIfNeeded()
            } else {
                view.fitImage()
            }
            let after = view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: view.imageView)
            #expect(abs(after.x - expected.x) < 0.5 && abs(after.y - expected.y) < 0.5)
            #expect(abs(view.zoomScale / view.minimumZoomScale - 3) < 0.0001)
        }
    }

    #endif
}
