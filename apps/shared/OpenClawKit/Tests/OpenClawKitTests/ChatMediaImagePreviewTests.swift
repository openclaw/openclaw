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
        (CGSize(width: 120, height: 80), CGSize(width: 393, height: 852), CGFloat(393.0 / 120.0)),
        (CGSize.zero, CGSize(width: 393, height: 852), CGFloat(1)),
    ])
    func `fit scale fills the constrained edge, growing small images`(
        image: CGSize,
        bounds: CGSize,
        expected: CGFloat)
    {
        let scale = ChatImagePreviewLayout.fitScale(imageSize: image, boundsSize: bounds)
        #expect(abs(scale - expected) < 0.0001)
        #expect(image.width * scale <= bounds.width + 0.001)
        #expect(image.height * scale <= bounds.height + 0.001)
        if image != .zero {
            #expect(
                abs(image.width * scale - bounds.width) < 0.001 || abs(image.height * scale - bounds.height) < 0.001,
                "One edge of the image touches the screen edge")
        }
    }

    @Test func `resting inset centers between the bars, then slides to the edges without a jump`() {
        // iPhone 17 Pro portrait: bar bottom at 114 pt, home indicator 34 pt.
        let bounds: CGFloat = 874
        let inset = { (content: CGFloat) in
            ChatImagePreviewLayout.restingInset(
                content: content, bounds: bounds, obstructedLeading: 114, obstructedTrailing: 34)
        }
        #expect(inset(402) == 276, "\(inset(402))") // 114 + (726 - 402) / 2
        #expect(inset(874) == 0)
        #expect(inset(1200) == 0)
        var previous = inset(0)
        for step in 1...900 {
            let content = CGFloat(step)
            let value = inset(content)
            #expect(value >= 0 && value <= max(0, bounds - content), "content stays inside the view")
            #expect(previous - value <= 1.0001, "no jump while zooming at \(content)")
            if content <= 874 - 114 - 34 { #expect(value >= 114, "clear of the bar when it fits") }
            previous = value
        }
    }

    @Test func `deepest zoom reaches four times the fit or two screen pixels per image pixel`() {
        // A 1600 px square on a 402 pt screen: 4x the fit is already finer than 2 px per pixel.
        let squareFit = ChatImagePreviewLayout.fitScale(
            imageSize: CGSize(width: 1600, height: 1600), boundsSize: CGSize(width: 402, height: 874))
        #expect(ChatImagePreviewLayout.maximumZoomScale(fitScale: squareFit, displayScale: 3) == squareFit * 4)
        // A 4032 px photo: 4x the fit would stop short of its pixels.
        let photoFit = ChatImagePreviewLayout.fitScale(
            imageSize: CGSize(width: 4032, height: 3024), boundsSize: CGSize(width: 402, height: 874))
        #expect(abs(ChatImagePreviewLayout.maximumZoomScale(fitScale: photoFit, displayScale: 3) - 2.0 / 3.0) < 0.0001)
    }

    @Test(arguments: [(0, 1, nil), (0, 3, "1 of 3"), (1, 3, "2 of 3"), (2, 3, "3 of 3"), (3, 3, nil)] as [(
        Int,
        Int,
        String?)])
    func `position shows only for several images`(index: Int, count: Int, expected: String?) {
        #expect(ChatImageViewerItem.positionText(index: index, count: count) == expected)
    }

    @Test(arguments: [
        (CGVector(dx: 0, dy: 800), false, true),
        (CGVector(dx: 300, dy: 400), false, true),
        (CGVector(dx: 800, dy: 100), false, false),
        (CGVector(dx: -800, dy: 0), false, false),
        (CGVector(dx: 0, dy: -600), false, false),
        (CGVector(dx: 0, dy: 800), true, false),
    ])
    func `only a downward drag on the fitted image closes the viewer`(
        velocity: CGVector,
        zoomed: Bool,
        expected: Bool)
    {
        #if os(iOS)
        #expect(ChatImageViewerController.allowsInteractiveDismiss(velocity: velocity, isZoomed: zoomed) == expected)
        #endif
    }

    @Test func `gallery holds the message's fetchable images in order`() {
        let contents = [
            OpenClawChatMessageContent(type: "text", text: "Here you go"),
            OpenClawChatMessageContent(
                type: "image",
                mimeType: "image/jpeg",
                artifactId: "artifact_managed_image_1",
                alt: "ridge-trail.jpg",
                width: 2400,
                height: 1600),
            OpenClawChatMessageContent(type: "file", mimeType: "application/pdf", fileName: "notes.pdf"),
            OpenClawChatMessageContent(
                type: "image",
                mimeType: "image/png",
                fileName: "sketch.png",
                artifactId: "artifact_managed_image_2",
                alt: "A sketch of the architecture"),
            OpenClawChatMessageContent(type: "image", mimeType: "image/png", alt: "Generated image 1"),
            OpenClawChatMessageContent(type: "image", artifactId: "artifact_managed_media_3"),
        ]
        let gallery = ChatImageViewerItem.gallery(in: contents)
        #expect(gallery.map(\.artifactId) == ["artifact_managed_image_1", "artifact_managed_image_2"])
        #expect(gallery[0].title == "ridge-trail.jpg")
        #expect(gallery[0].pixelSize == CGSize(width: 2400, height: 1600))
        #expect(gallery[1].title == "sketch.png")
        #expect(gallery[1].label == "A sketch of the architecture")
        #expect(gallery[1].pixelSize == nil)
        #expect(ChatImageViewerItem.viewerItems(gallery, opening: "artifact_managed_image_2", label: "x") == gallery)
        #expect(ChatImageViewerItem.viewerItems([], opening: "artifact_managed_image_9", label: "Photo").count == 1)
    }

    @Test(arguments: [
        ("chart.png", true), ("photo-AC3B5B0F.jpg", true), ("A cat on a sofa", false),
        ("Generated image 1", false), ("dir/file.png", false), ("report.final.jpeg", true),
    ])
    func `only file names become the viewer title`(alt: String, expected: Bool) {
        #expect(ChatImageViewerItem.looksLikeFileName(alt) == expected)
    }

    @Test(arguments: [
        (CGSize(width: 1600, height: 1600), CGSize(width: 1600, height: 1600) as CGSize?, true),
        (CGSize(width: 2048, height: 1536), CGSize(width: 4032, height: 3024) as CGSize?, false),
        (CGSize(width: 2048, height: 1536), CGSize(width: 8000, height: 6000) as CGSize?, false),
        (CGSize(width: 1000, height: 800), nil as CGSize?, true),
        (CGSize(width: 2048, height: 1024), nil as CGSize?, false),
    ])
    func `viewer reloads only images the transcript downsampled`(
        thumbnail: CGSize,
        original: CGSize?,
        expected: Bool)
    {
        #expect(ChatImageViewerItem.thumbnailIsFullResolution(
            thumbnailPixelSize: thumbnail, originalPixelSize: original) == expected)
    }

    @Test func `viewer decodes large originals at most 4096 pixels on the long side`() {
        #expect(ChatImageViewerItem.displayPixelSize(CGSize(width: 8000, height: 6000)) == CGSize(
            width: 4096,
            height: 3072))
        #expect(ChatImageViewerItem.displayPixelSize(CGSize(width: 4032, height: 3024)) == CGSize(
            width: 4032,
            height: 3024))
    }

    #if os(macOS)
    @Test func `close button hit target is at least 44 points`() {
        let button = ChatImagePreviewCloseButton {}
        let size = NSHostingController(rootView: button).sizeThatFits(in: CGSize(width: 1000, height: 1000))
        #expect(size.width >= 44)
        #expect(size.height >= 44)
    }
    #endif

    #if os(iOS)
    @Test(arguments: [
        // A square diagram rests between the bar and the home indicator, edge to edge.
        (CGSize(width: 1600, height: 1600), CGRect(x: 0, y: 276, width: 402, height: 402)),
        // A landscape photo: full width, between the bars.
        (CGSize(width: 2400, height: 1600), CGRect(x: 0, y: 343, width: 402, height: 268)),
        // A phone screenshot fills the screen; the bar floats over it until a tap hides it.
        (CGSize(width: 1206, height: 2622), CGRect(x: 0, y: 0, width: 402, height: 874)),
        // Taller than the screen: full height, side bands only from its own shape.
        (CGSize(width: 1000, height: 4000), CGRect(x: 91.75, y: 0, width: 218.5, height: 874)),
    ])
    func `zoom view opens edge to edge, clear of the bar when it fits`(pixels: CGSize, expected: CGRect) {
        let view = ChatZoomableImageScrollView(image: nil, pixelSize: pixels)
        view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        view.obstructedInsets = UIEdgeInsets(top: 114, left: 0, bottom: 34, right: 0)
        view.layoutIfNeeded()

        let fit = ChatImagePreviewLayout.fitScale(imageSize: pixels, boundsSize: view.bounds.size)
        #expect(abs(view.zoomScale - fit) < 0.0001)
        #expect(view.minimumZoomScale == fit)
        #expect(!view.isZoomed)
        // Image frame in the view's own coordinate space (bounds origin is the content offset).
        let frame = view.convert(view.imageView.bounds, from: view.imageView)
            .offsetBy(dx: -view.bounds.minX, dy: -view.bounds.minY)
        #expect(abs(frame.minX - expected.minX) < 0.5 && abs(frame.minY - expected.minY) < 0.5)
        #expect(abs(frame.width - expected.width) < 0.5 && abs(frame.height - expected.height) < 0.5)
    }

    @Test func `sharper image swaps in place without moving the fitted frame`() {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let thumbnail = UIGraphicsImageRenderer(size: CGSize(width: 2048, height: 1536), format: format)
            .image { _ in }
        let full = UIGraphicsImageRenderer(size: CGSize(width: 4032, height: 3024), format: format).image { _ in }
        let view = ChatZoomableImageScrollView(image: thumbnail, pixelSize: CGSize(width: 4032, height: 3024))
        view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        view.layoutIfNeeded()
        let before = view.convert(view.imageView.bounds, from: view.imageView)
        view.setImage(full)
        view.layoutIfNeeded()
        #expect(view.imageView.image === full)
        #expect(view.convert(view.imageView.bounds, from: view.imageView) == before)
    }

    @Test func `zooming in reports zoomed so the bar can hide`() {
        let view = ChatZoomableImageScrollView(image: nil, pixelSize: CGSize(width: 1600, height: 1600))
        view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        view.layoutIfNeeded()
        var reports: [Bool] = []
        view.onZoomedChange = { reports.append($0) }
        view.setZoomScale(view.minimumZoomScale * 2, animated: false)
        view.setZoomScale(view.minimumZoomScale, animated: false)
        #expect(reports == [true, false])
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

    /// Diagnostic only: a real UIKit owner, synthetic pixels, and a fixed image-space target.
    /// The no-resize argument is a green fixture control; neither argument uses a Gateway.
    @Test(arguments: [false, true])
    func `rotation preserves panned image focal point`(rotate: Bool) throws {
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
    func `successive refits preserve current panned focal point`(resizeBounds: Bool, scenario: (Bool, Double)) throws {
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
                view.obstructedInsets = UIEdgeInsets(top: CGFloat(index + 1) * 4, left: 8, bottom: 8, right: 4)
            }
            view.setNeedsLayout()
            view.layoutIfNeeded()
            if !insetsBeforeLayout {
                view.obstructedInsets = UIEdgeInsets(top: CGFloat(index + 1) * 4, left: 8, bottom: 8, right: 4)
                view.layoutIfNeeded()
            }
            view.fitImage() // A same-size refit must not replay the previous resize.
            let after = view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: view.imageView)
            #expect(abs(after.x - expected.x) < 0.5 && abs(after.y - expected.y) < 0.5)
            #expect(abs(view.zoomScale / view.minimumZoomScale - relativeZoom) < 0.0001)
        }
    }

    @Test(arguments: [false, true])
    func `queued resizes consume anchor once`(resizeBounds: Bool) throws {
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
