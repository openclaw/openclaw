import Foundation
import Testing
@testable import OpenClawChatUI

#if os(macOS)
import AppKit
#endif

#if os(macOS)
private func luminance(_ color: NSColor) throws -> CGFloat {
    let rgb = try #require(color.usingColorSpace(.deviceRGB))

    // Calculate relative luminance using WCAG formula with gamma linearization
    func linearize(_ component: CGFloat) -> CGFloat {
        component <= 0.04045 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
    }

    let rLinear = linearize(rgb.redComponent)
    let gLinear = linearize(rgb.greenComponent)
    let bLinear = linearize(rgb.blueComponent)

    return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear
}
#endif

@Suite struct ChatThemeTests {
    @Test func assistantBubbleResolvesForLightAndDark() throws {
        #if os(macOS)
        let lightAppearance = try #require(NSAppearance(named: .aqua))
        let darkAppearance = try #require(NSAppearance(named: .darkAqua))

        let lightResolved = OpenClawChatTheme.resolvedAssistantBubbleColor(for: lightAppearance)
        let darkResolved = OpenClawChatTheme.resolvedAssistantBubbleColor(for: darkAppearance)
        #expect(try luminance(lightResolved) > luminance(darkResolved))
        #else
        #expect(Bool(true))
        #endif
    }
}
