import Testing
import UIKit
@testable import OpenClawChatUI

extension OpenClawTypographyTests {
    @MainActor
    @Test func `composer uses the system body size at the current Dynamic Type category`() throws {
        let category = UIApplication.shared.preferredContentSizeCategory
        let base = try #require(
            UIFont(name: "Inter-Regular", size: 17),
            "The app host must register its bundled Inter font")
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        let expected = UIFontMetrics(forTextStyle: .body).scaledFont(for: base, compatibleWith: traits)
        let composer = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        let actual = try #require(composer.font)

        #expect(actual.fontName == base.fontName)
        #expect(composer.adjustsFontForContentSizeCategory)
        #expect(
            abs(actual.pointSize - expected.pointSize) < 0.01,
            "Composer must use the 17-point system body scaled for the actual host category")
    }
}
