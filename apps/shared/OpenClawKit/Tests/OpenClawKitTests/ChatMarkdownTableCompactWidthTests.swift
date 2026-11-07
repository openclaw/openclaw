import Foundation
import SwiftUI
import Testing
#if os(macOS)
import AppKit
#endif
@testable import OpenClawChatUI

/// Rendered coverage for the shared chat table: every case here measures what a reply actually
/// draws, so a layout that clips the reported table or keeps the compact cell size fails.
@MainActor
struct ChatMarkdownTableCompactWidthTests {
    /// The two-column shape reported on an iPhone 15: a medium-length first column and short
    /// phrases in the second, which together are wider than a compact screen but not by much.
    private static let reportedTableMarkdown = """
    | Oil | Best uses |
    | --- | --- |
    | Canola oil (ideally cold-pressed) | Sautéing, roasting, drizzling |
    | Ghee or clarified butter | Baking, stir-fries, all-purpose |
    | Extra virgin olive oil | Dressings, low-heat finishing |
    """

    #if os(macOS)
    @Test func `reported table wraps at compact width after resizing`() throws {
        _ = NSApplication.shared
        let heights = try Self.renderedInkHeights(
            of: Self.reply(Self.reportedTableMarkdown),
            widths: [390, 1200, 390])
        let compactInkHeight = heights[0]
        let wideInkHeight = heights[1]
        #expect(compactInkHeight > 0)
        #expect(wideInkHeight > 0)
        // Every column keeps one line at 1200 pt. At 390 pt the same table only stays inside the
        // card when cells wrap, so the compact rendering must be taller; equal heights mean the
        // columns stayed on one line and the last one ran off the edge.
        #expect(compactInkHeight > wideInkHeight + 2)
        // Keep the same view alive: a stale wide column width must not survive narrowing.
        #expect(abs(heights[2] - compactInkHeight) <= 2)
    }

    @Test func `table cells render at the reply prose size instead of the footnote size`() throws {
        _ = NSApplication.shared
        let wide: CGFloat = 1200
        let oneRowInkHeight = try Self.renderedInkHeight(
            of: Self.reply(Self.pitchTableMarkdown(bodyRows: 1)),
            width: wide)
        let twoRowInkHeight = try Self.renderedInkHeight(
            of: Self.reply(Self.pitchTableMarkdown(bodyRows: 2)),
            width: wide)
        let cellPitch = twoRowInkHeight - oneRowInkHeight
        let prosePitch = try Self.probePitch(font: ChatMarkdownRenderer.Typography.response.proseFont)
        let footnotePitch = try Self.probePitch(font: OpenClawChatTypography.footnote)
        // One extra body row adds one cell line plus the grid's vertical spacing, and the probes are
        // built with that same spacing, so all three pitches measure the cell's rendered line height.
        #expect(prosePitch > footnotePitch + 1.5)
        #expect(abs(cellPitch - prosePitch) <= 1.5)
        #expect(cellPitch > footnotePitch + 1.5)
    }

    /// A table whose body rows stay on one line at this width, so the ink difference between two
    /// row counts is a single cell line.
    private static func pitchTableMarkdown(bodyRows: Int) -> String {
        var lines = ["| Oil | Best uses |", "| --- | --- |"]
        for index in 0..<bodyRows {
            lines.append("| Olive oil \(index) | Finishing \(index) |")
        }
        return lines.joined(separator: "\n")
    }

    private static func reply(_ markdown: String) -> some View {
        ChatMarkdownRenderer(
            text: markdown,
            context: .assistant,
            variant: .standard,
            textColor: OpenClawChatTheme.assistantText)
    }

    /// Plain text rows carrying the grid's own vertical spacing, so their ink pitch is directly
    /// comparable with a table row's.
    private static func probe(font: Font, lines: Int) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(0..<lines), id: \.self) { _ in
                Text("Extra virgin olive oil")
                    .font(font)
                    .foregroundStyle(Color.black)
            }
        }
        .padding(10)
        .background(Color.white)
    }

    private static func probePitch(font: Font) throws -> CGFloat {
        let wide: CGFloat = 1200
        let singleLine = try Self.renderedInkHeight(of: Self.probe(font: font, lines: 1), width: wide)
        let twoLines = try Self.renderedInkHeight(of: Self.probe(font: font, lines: 2), width: wide)
        return twoLines - singleLine
    }

    private static func renderedInkHeight(of view: some View, width: CGFloat) throws -> CGFloat {
        try self.renderedInkHeights(of: view, widths: [width])[0]
    }

    private static func renderedInkHeights(of view: some View, widths: [CGFloat]) throws -> [CGFloat] {
        let canvasHeight: CGFloat = 700
        func content(width: CGFloat) -> some View {
            view
                .frame(width: width, alignment: .topLeading)
                .background(Color.white)
        }
        let host = NSHostingView(rootView: content(width: widths[0]))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: widths[0], height: canvasHeight),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer {
            window.contentView = nil
            window.close()
        }
        return try widths.map { width in
            host.rootView = content(width: width)
            window.setContentSize(NSSize(width: width, height: canvasHeight))
            host.frame = NSRect(x: 0, y: 0, width: width, height: canvasHeight)
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            return Self.inkHeight(bitmap)
        }
    }

    /// Height of the drawn band, measured from the first to the last row carrying non-white ink.
    private static func inkHeight(_ bitmap: NSBitmapImageRep) -> CGFloat {
        var firstInkedRow: Int?
        var lastInkedRow: Int?
        for row in 0..<bitmap.pixelsHigh where Self.rowHasInk(bitmap, row: row) {
            if firstInkedRow == nil { firstInkedRow = row }
            lastInkedRow = row
        }
        guard let first = firstInkedRow, let last = lastInkedRow else { return 0 }
        return CGFloat(last - first + 1)
    }

    private static func rowHasInk(_ bitmap: NSBitmapImageRep, row: Int) -> Bool {
        // Unpainted hosting-view pixels are transparent black, not text.
        // Sampling every fourth pixel keeps the scan cheap while still hitting text strokes.
        var column = 0
        while column < bitmap.pixelsWide {
            if let color = bitmap.colorAt(x: column, y: row)?.usingColorSpace(.sRGB),
               color.alphaComponent > 0,
               min(color.redComponent, color.greenComponent, color.blueComponent) < 0.99
            {
                return true
            }
            column += 4
        }
        return false
    }
    #endif
}
