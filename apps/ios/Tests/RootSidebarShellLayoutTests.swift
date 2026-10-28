import QuartzCore
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct RootSidebarShellLayoutTests {
    @Test(arguments: [false, true])
    func `drawer card paints through vertical safe areas while split content stays inset`(isDrawerLayout: Bool) throws {
        let root = GeometryReader { proxy in
            RootSidebarShell(
                sidebarWidth: 80,
                isDrawerLayout: isDrawerLayout,
                isPresented: true,
                canOpenFromEdge: true,
                reduceMotion: false,
                animation: nil,
                onShow: {},
                onHide: {},
                // A wide contrasting underlay exposes gaps behind the moving card.
                sidebar: Color.clear
                    .frame(width: proxy.size.width)
                    .background(Color(uiColor: .blue), ignoresSafeAreaEdges: .vertical),
                detail: Color(uiColor: .red))
        }
        let image = try Self.render(root)
        let red: [UInt8] = [255, 0, 0, 255]
        let blue: [UInt8] = [0, 0, 255, 255]
        // Sample away from the corners and the sidebar so only the card's vertical extent matters.
        let x = Int(image.size.width / 2)
        let center = try Self.pixel(in: image, x: x, y: Int(image.size.height / 2))
        let top = try Self.pixel(in: image, x: x, y: 1)
        let bottom = try Self.pixel(in: image, x: x, y: Int(image.size.height) - 2)
        // The revealed card is tinted, but the detail must still paint beneath it.
        try #require(center[0] > center[1] && center[0] > center[2])
        if !isDrawerLayout { #expect(center == red) }
        #expect((top != blue) == isDrawerLayout, "Top edge pixel: \(top)")
        #expect((bottom != blue) == isDrawerLayout, "Bottom edge pixel: \(bottom)")
    }

    @Test(arguments: [UIUserInterfaceStyle.light, .dark])
    func `reduced motion drawer paints one sidebar surface across the window`(appearance: UIUserInterfaceStyle) throws {
        let root = RootSidebarShell(
            sidebarWidth: 80,
            isDrawerLayout: true,
            isPresented: true,
            canOpenFromEdge: true,
            reduceMotion: true,
            animation: nil,
            onShow: {},
            onHide: {},
            sidebar: Color.clear,
            detail: Color(uiColor: .red))
        let image = try Self.render(root, appearance: appearance)
        let sidebar = try Self.pixel(in: image, x: 40, y: Int(image.size.height / 2))
        let backdrop = try Self.pixel(in: image, x: Int(image.size.width / 2), y: Int(image.size.height / 2))
        #expect(backdrop == sidebar, "Sidebar: \(sidebar), exposed backdrop: \(backdrop)")
    }

    @Test(arguments: [false, true])
    func `drawer card clips corners only while the sidebar is revealed`(isPresented: Bool) throws {
        let root = RootSidebarShell(
            sidebarWidth: 80,
            isDrawerLayout: true,
            isPresented: isPresented,
            canOpenFromEdge: true,
            reduceMotion: false,
            animation: nil,
            onShow: {},
            onHide: {},
            sidebar: Color.clear,
            detail: Color(uiColor: .red))
        let image = try Self.render(root)
        let red: [UInt8] = [255, 0, 0, 255]
        let left = isPresented ? 80 : 0
        // A resting page fills all four corners, including pixels visible in screenshots.
        let topCenter = try Self.pixel(in: image, x: Int(image.size.width / 2), y: 2)
        let topCorner = try Self.pixel(in: image, x: left + 1, y: 1)
        let bottomCorner = try Self.pixel(in: image, x: left + 1, y: Int(image.size.height) - 2)
        try #require(topCenter[0] > topCenter[1] && topCenter[0] > topCenter[2])
        if !isPresented { #expect(topCenter == red) }
        #expect((topCorner != topCenter) == isPresented, "Top corner: \(topCorner)")
        #expect((bottomCorner != topCenter) == isPresented, "Bottom corner: \(bottomCorner)")
        if !isPresented {
            let right = Int(image.size.width) - 2
            let topTrailing = try Self.pixel(in: image, x: right, y: 1)
            let bottomTrailing = try Self.pixel(in: image, x: right, y: Int(image.size.height) - 2)
            #expect(topTrailing == red, "Top trailing corner: \(topTrailing)")
            #expect(bottomTrailing == red, "Bottom trailing corner: \(bottomTrailing)")
        }
    }

    @Test func `moving card keeps full corners until its animated offset reaches zero`() {
        let bounds = CGRect(x: 0, y: 0, width: 300, height: 600)
        let radii = RectangleCornerRadii(topLeading: 52, bottomLeading: 40, bottomTrailing: 40, topTrailing: 52)
        let fullOutline = UnevenRoundedRectangle(cornerRadii: radii, style: .continuous).path(in: bounds)
        let corners = [
            CGPoint(x: 1, y: 1),
            CGPoint(x: 299, y: 1),
            CGPoint(x: 1, y: 599),
            CGPoint(x: 299, y: 599),
        ]
        // The closing model is already at zero; SwiftUI supplies its presentation offset.
        var shape = RootSidebarCardShape(offset: 0, cornerRadii: radii)
        for offset: CGFloat in [0.01, 80, 40, 0.01, -0.01] {
            shape.animatableData = offset
            #expect(shape.path(in: bounds) == fullOutline, "Animated offset: \(offset)")
        }
        shape.animatableData = 0
        let restingOutline = shape.path(in: bounds)
        #expect(corners.allSatisfy { restingOutline.contains($0) })
    }

    private static func render(
        _ root: some View,
        appearance: UIUserInterfaceStyle = .unspecified) throws -> UIImage
    {
        let host = UIHostingController(rootView: root)
        host.overrideUserInterfaceStyle = appearance
        // Nonzero container insets make this contract independent of the test device.
        host.additionalSafeAreaInsets = UIEdgeInsets(top: 20, left: 0, bottom: 20, right: 0)
        let scene = try #require(UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive })
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        host.view.layoutIfNeeded()
        CATransaction.flush()
        #expect(host.view.safeAreaInsets.top > 0)
        #expect(host.view.safeAreaInsets.bottom > 0)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: window.bounds.size, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
    }

    private static func pixel(in image: UIImage, x: Int, y: Int) throws -> [UInt8] {
        let image = try #require(image.cgImage)
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        try bytes.withUnsafeMutableBytes { buffer in
            let context = try #require(CGContext(
                data: buffer.baseAddress,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: image.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        let index = (y * image.width + x) * 4
        return Array(bytes[index..<index + 4])
    }
}
