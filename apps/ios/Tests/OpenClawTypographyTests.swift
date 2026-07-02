import Testing
import UIKit
@testable import OpenClaw

struct OpenClawTypographyTests {
    @Test func `bundled fonts load from app bundle`() {
        for name in OpenClawType.registeredPostScriptNames {
            #expect(UIFont(name: name, size: 12) != nil, "Missing bundled font: \(name)")
        }
    }

    @Test func `dynamic type scales display fonts`() {
        guard let base = UIFont(name: "PlusJakartaSans-ExtraBold", size: 34) else {
            Issue.record("PlusJakartaSans-ExtraBold should be bundled")
            return
        }

        let defaultTraits = UITraitCollection(preferredContentSizeCategory: .large)
        let largeTraits = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
        let metrics = UIFontMetrics(forTextStyle: .largeTitle)

        let defaultSize = metrics.scaledFont(for: base, compatibleWith: defaultTraits).pointSize
        let largeSize = metrics.scaledFont(for: base, compatibleWith: largeTraits).pointSize

        #expect(largeSize > defaultSize)
    }
}
