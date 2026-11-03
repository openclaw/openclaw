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
    #endif
}
