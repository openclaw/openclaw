import AppKit
import SwiftUI

enum VeriClawBrandAsset {
    static let image: NSImage? = {
        guard let url = OpenClawResources.bundle.url(forResource: "VeriClawBrandMark", withExtension: "png") else {
            return nil
        }
        return NSImage(contentsOf: url)
    }()

    static func statusBarImage(
        size: CGFloat = 18,
        paused: Bool = false,
        sleeping: Bool = false,
        badgeSymbolName: String? = nil,
        badgeProminence: IconState.BadgeProminence? = nil) -> NSImage
    {
        let logicalSize = NSSize(width: size, height: size)
        let pixels = max(36, Int(size * 2))
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixels,
            pixelsHigh: pixels,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bitmapFormat: [],
            bytesPerRow: 0,
            bitsPerPixel: 0)
        else {
            return NSImage(size: logicalSize)
        }

        rep.size = logicalSize
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }

        guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
            return NSImage(size: logicalSize)
        }
        NSGraphicsContext.current = context
        context.cgContext.clear(CGRect(origin: .zero, size: logicalSize))
        context.imageInterpolation = .high

        let drawRect = CGRect(origin: .zero, size: logicalSize)
        let baseAlpha: CGFloat = paused ? 0.76 : (sleeping ? 0.58 : 1.0)

        if let image = self.image {
            image.draw(
                in: drawRect,
                from: .zero,
                operation: .sourceOver,
                fraction: baseAlpha,
                respectFlipped: true,
                hints: [.interpolation: NSImageInterpolation.high])
        } else {
            NSColor.windowBackgroundColor.setFill()
            NSBezierPath(roundedRect: drawRect, xRadius: size * 0.24, yRadius: size * 0.24).fill()
        }

        if sleeping {
            NSColor.white.withAlphaComponent(0.20).setFill()
            NSBezierPath(roundedRect: drawRect, xRadius: size * 0.24, yRadius: size * 0.24).fill()
        }

        if let badgeSymbolName, let badgeProminence {
            self.drawBadge(
                symbolName: badgeSymbolName,
                prominence: badgeProminence,
                in: context.cgContext,
                size: size)
        }

        let image = NSImage(size: logicalSize)
        image.addRepresentation(rep)
        image.isTemplate = false
        return image
    }

    private static func drawBadge(
        symbolName: String,
        prominence: IconState.BadgeProminence,
        in context: CGContext,
        size: CGFloat)
    {
        let strength: CGFloat = switch prominence {
        case .primary: 1.0
        case .secondary: 0.68
        case .overridden: 0.88
        }

        let diameter = size * (0.54 + 0.05 * strength)
        let margin = size * 0.02
        let rect = CGRect(
            x: size - diameter - margin,
            y: margin,
            width: diameter,
            height: diameter)

        context.saveGState()
        context.setShouldAntialias(true)

        context.setFillColor(NSColor.black.withAlphaComponent(0.78 + 0.10 * strength).cgColor)
        context.addEllipse(in: rect)
        context.fillPath()

        context.setStrokeColor(NSColor.white.withAlphaComponent(0.72).cgColor)
        context.setLineWidth(1)
        context.strokeEllipse(in: rect.insetBy(dx: 0.5, dy: 0.5))

        if let base = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
            let pointSize = max(7.0, diameter * 0.72)
            let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .bold)
            let symbol = base.withSymbolConfiguration(config) ?? base
            let symbolRect = rect.insetBy(dx: diameter * 0.20, dy: diameter * 0.20)
            symbol.isTemplate = true
            context.saveGState()
            context.setBlendMode(.clear)
            symbol.draw(
                in: symbolRect,
                from: .zero,
                operation: .sourceOver,
                fraction: 1,
                respectFlipped: true,
                hints: nil)
            context.restoreGState()
        }

        context.restoreGState()
    }
}

struct VeriClawBrandTile: View {
    var size: CGFloat = 40

    var body: some View {
        Group {
            if let image = VeriClawBrandAsset.image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                    .fill(Color(nsColor: .windowBackgroundColor))
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                .strokeBorder(Color.white.opacity(0.54), lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: size * 0.20, y: size * 0.10)
    }
}
