import SwiftUI
import Testing
@testable import OpenClawChatUI

/// The reactions pill follows the Control UI tab: the three most used faces, ties in arrival order,
/// and a total that counts every person on every emoji.
struct ChatReactionSummaryTests {
    private static func reaction(_ emoji: String, _ count: Int) -> OpenClawChatReactionSummary {
        OpenClawChatReactionSummary(emoji: emoji, count: count, identities: [])
    }

    @Test func `no reactions has no pill`() {
        #expect(ChatReactionSummary([]) == nil)
    }

    @Test func `one reaction shows its face and a total of one`() throws {
        let summary = try #require(ChatReactionSummary([Self.reaction("❤️", 1)]))
        #expect(summary.faces == ["❤️"])
        #expect(summary.total == 1)
    }

    @Test @MainActor func `single and grouped user reactions leave a visible capsule around the faces`() throws {
        for theme in [ColorScheme.light, .dark] {
            for reactions in [[Self.reaction("👍", 1)], [Self.reaction("👍", 1), Self.reaction("🎉", 1)]] {
                let summary = try #require(ChatReactionSummary(reactions))
                let label = ImageRenderer(content: ChatReactionPillLabel(summary: summary)
                    .environment(\.openClawReactionPillOnUserBubble, true)
                    .environment(\.colorScheme, theme))
                let image = try #require(label.cgImage)
                #expect(image.width >= image.height + 4)
                let surface = ImageRenderer(content: OpenClawChatTheme.userBubbleSurface(in: theme, accent: nil)
                    .frame(width: 1, height: 1).environment(\.colorScheme, theme))
                let bubble = try #require(surface.cgImage)
                let edge = try Self.pixel(image, x: 4, y: image.height / 2)
                #expect(try edge == (Self.pixel(bubble, x: 0, y: 0)))
                #expect(try edge != (Self.pixel(image, x: 1, y: image.height / 2)))
            }
        }
    }

    private static func pixel(_ image: CGImage, x: Int, y: Int) throws -> [UInt8] {
        let cropped = try #require(image.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)))
        var bytes = [UInt8](repeating: 0, count: 4)
        try bytes.withUnsafeMutableBytes { buffer in
            let context = try #require(CGContext(
                data: buffer.baseAddress,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cropped, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        return bytes
    }

    @Test func `the three most used faces show, ties keep arrival order`() throws {
        let summary = try #require(ChatReactionSummary([
            Self.reaction("👍", 1), Self.reaction("🎉", 3), Self.reaction("👀", 2),
            Self.reaction("🚀", 3), Self.reaction("😂", 1),
        ]))
        #expect(summary.faces == ["🎉", "🚀", "👀"])
        #expect(summary.total == 10)
    }
}
