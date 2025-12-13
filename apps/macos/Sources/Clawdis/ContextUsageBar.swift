import AppKit
import SwiftUI

struct ContextUsageBar: View {
    let usedTokens: Int
    let contextTokens: Int
    var width: CGFloat?
    var height: CGFloat = 6

    private var clampedFractionUsed: Double {
        guard self.contextTokens > 0 else { return 0 }
        return min(1, max(0, Double(self.usedTokens) / Double(self.contextTokens)))
    }

    private var percentUsed: Int? {
        guard self.contextTokens > 0, self.usedTokens > 0 else { return nil }
        return min(100, Int(round(self.clampedFractionUsed * 100)))
    }

    private var tint: Color {
        guard let pct = self.percentUsed else { return .secondary }
        if pct >= 95 { return Color(nsColor: .systemRed) }
        if pct >= 80 { return Color(nsColor: .systemOrange) }
        if pct >= 60 { return Color(nsColor: .systemYellow) }
        return Color(nsColor: .systemGreen)
    }

    var body: some View {
        // SwiftUI menus (MenuBarExtraStyle.menu) drop certain view types (including ProgressView/Canvas).
        // Render the bar as an image to reliably display inside the menu.
        Group {
            if let width = self.width, width > 0 {
                Image(nsImage: Self.renderBar(
                    width: width,
                    height: self.height,
                    fractionUsed: self.clampedFractionUsed,
                    percentUsed: self.percentUsed))
                    .resizable()
                    .interpolation(.none)
                    .frame(width: width, height: self.height)
            } else {
                GeometryReader { proxy in
                    Image(nsImage: Self.renderBar(
                        width: proxy.size.width,
                        height: self.height,
                        fractionUsed: self.clampedFractionUsed,
                        percentUsed: self.percentUsed))
                        .resizable()
                        .interpolation(.none)
                        .frame(width: proxy.size.width, height: self.height)
                }
                .frame(height: self.height)
            }
        }
        .accessibilityLabel("Context usage")
        .accessibilityValue(self.accessibilityValue)
    }

    private var accessibilityValue: String {
        if self.contextTokens <= 0 { return "Unknown context window" }
        let pct = Int(round(self.clampedFractionUsed * 100))
        return "\(pct) percent used"
    }

    private static func renderBar(
        width: CGFloat,
        height: CGFloat,
        fractionUsed: Double,
        percentUsed: Int?) -> NSImage
    {
        let clamped = min(1, max(0, fractionUsed))
        let size = NSSize(width: max(1, width), height: max(1, height))
        let image = NSImage(size: size)
        image.isTemplate = false

        image.lockFocus()
        defer { image.unlockFocus() }

        let rect = NSRect(origin: .zero, size: size)
        let radius = rect.height / 2

        let background = NSColor.white.withAlphaComponent(0.12)
        let stroke = NSColor.white.withAlphaComponent(0.18)

        let fill: NSColor = {
            guard let pct = percentUsed else { return NSColor.secondaryLabelColor }
            if pct >= 95 { return .systemRed }
            if pct >= 80 { return .systemOrange }
            if pct >= 60 { return .systemYellow }
            return .systemGreen
        }()

        let track = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        background.setFill()
        track.fill()
        stroke.setStroke()
        track.lineWidth = 0.75
        track.stroke()

        let fillWidth = max(1, floor(rect.width * clamped))
        let fillRect = NSRect(x: rect.minX, y: rect.minY, width: fillWidth, height: rect.height)
        let clip = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        clip.addClip()
        fill.setFill()
        NSBezierPath(rect: fillRect).fill()

        return image
    }
}
