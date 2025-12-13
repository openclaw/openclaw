import AppKit
import SwiftUI

/// Single-row context usage display that stays intact inside menu rendering.
///
/// SwiftUI menus tend to decompose view hierarchies into separate menu rows
/// (image row, text row, etc.). We render the combined layout into an image
/// so session name + numbers are guaranteed to appear on the same row.
struct ContextUsageRow: View {
    let sessionKey: String
    let summary: String
    let usedTokens: Int
    let contextTokens: Int
    let width: CGFloat
    var barHeight: CGFloat = 4
    var rowHeight: CGFloat = 18
    var isMain: Bool = false

    var body: some View {
        Image(nsImage: Self.renderRow(
            width: self.width,
            rowHeight: self.rowHeight,
            barHeight: self.barHeight,
            sessionKey: self.sessionKey,
            summary: self.summary,
            usedTokens: self.usedTokens,
            contextTokens: self.contextTokens,
            isMain: self.isMain))
            .resizable()
            .interpolation(.none)
            .frame(width: self.width, height: self.rowHeight)
            .accessibilityLabel("Context usage")
            .accessibilityValue("\(self.sessionKey) \(self.summary)")
    }

    private static func renderRow(
        width: CGFloat,
        rowHeight: CGFloat,
        barHeight: CGFloat,
        sessionKey: String,
        summary: String,
        usedTokens: Int,
        contextTokens: Int,
        isMain: Bool
    ) -> NSImage {
        let safeWidth = max(1, width)
        let safeRowHeight = max(1, rowHeight)
        let safeBarHeight = min(max(1, barHeight), safeRowHeight)

        let size = NSSize(width: safeWidth, height: safeRowHeight)
        let image = NSImage(size: size)
        image.isTemplate = false

        image.lockFocus()
        defer { image.unlockFocus() }

        let barRect = NSRect(x: 0, y: 0, width: size.width, height: safeBarHeight)
        drawBar(in: barRect, usedTokens: usedTokens, contextTokens: contextTokens)

        let textRect = NSRect(
            x: 0,
            y: safeBarHeight,
            width: size.width,
            height: size.height - safeBarHeight
        )
        drawText(in: textRect, sessionKey: sessionKey, summary: summary, isMain: isMain)

        return image
    }

    private static func drawText(in rect: NSRect, sessionKey: String, summary: String, isMain: Bool) {
        guard rect.width > 1, rect.height > 1 else { return }

        let keyFont = NSFont.systemFont(
            ofSize: NSFont.smallSystemFontSize,
            weight: isMain ? .semibold : .regular
        )
        let summaryFont = NSFont.monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)

        let keyParagraph = NSMutableParagraphStyle()
        keyParagraph.alignment = .left
        keyParagraph.lineBreakMode = .byTruncatingMiddle

        let summaryParagraph = NSMutableParagraphStyle()
        summaryParagraph.alignment = .right
        summaryParagraph.lineBreakMode = .byClipping

        let keyAttr = NSAttributedString(
            string: sessionKey,
            attributes: [
                .font: keyFont,
                .foregroundColor: NSColor.labelColor,
                .paragraphStyle: keyParagraph,
            ]
        )
        let summaryAttr = NSAttributedString(
            string: summary,
            attributes: [
                .font: summaryFont,
                .foregroundColor: NSColor.secondaryLabelColor,
                .paragraphStyle: summaryParagraph,
            ]
        )

        let summarySize = summaryAttr.size()
        let gap: CGFloat = 10
        let rightWidth = min(rect.width, ceil(summarySize.width))
        let leftWidth = max(1, rect.width - rightWidth - gap)

        let textHeight = max(keyAttr.size().height, summarySize.height)
        let y = rect.minY + floor((rect.height - textHeight) / 2)

        let leftRect = NSRect(x: rect.minX, y: y, width: leftWidth, height: textHeight)
        keyAttr.draw(with: leftRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])

        let rightRect = NSRect(
            x: rect.maxX - rightWidth,
            y: y,
            width: rightWidth,
            height: textHeight
        )
        summaryAttr.draw(with: rightRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    private static func drawBar(in rect: NSRect, usedTokens: Int, contextTokens: Int) {
        let radius = rect.height / 2
        let background = NSColor.white.withAlphaComponent(0.12)
        let stroke = NSColor.white.withAlphaComponent(0.18)

        let fractionUsed: Double = {
            guard contextTokens > 0 else { return 0 }
            return min(1, max(0, Double(usedTokens) / Double(contextTokens)))
        }()
        let percentUsed: Int? = {
            guard contextTokens > 0, usedTokens > 0 else { return nil }
            return min(100, Int(round(fractionUsed * 100)))
        }()

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

        let fillWidth = max(1, floor(rect.width * fractionUsed))
        let fillRect = NSRect(x: rect.minX, y: rect.minY, width: fillWidth, height: rect.height)
        let clip = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        clip.addClip()
        fill.setFill()
        NSBezierPath(rect: fillRect).fill()
    }
}

