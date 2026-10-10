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
        let host = UIHostingController(rootView: root)
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
        let image = UIGraphicsImageRenderer(size: window.bounds.size, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let red: [UInt8] = [255, 0, 0, 255]
        let blue: [UInt8] = [0, 0, 255, 255]
        // Sample away from the corners and the sidebar so only the card's vertical extent matters.
        let x = Int(window.bounds.midX)
        let center = try Self.pixel(in: image, x: x, y: Int(window.bounds.midY))
        let top = try Self.pixel(in: image, x: x, y: 1)
        let bottom = try Self.pixel(in: image, x: x, y: Int(window.bounds.height) - 2)
        try #require(center == red)
        #expect((top != blue) == isDrawerLayout, "Top edge pixel: \(top)")
        #expect((bottom != blue) == isDrawerLayout, "Bottom edge pixel: \(bottom)")
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
