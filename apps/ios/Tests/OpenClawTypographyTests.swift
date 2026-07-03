import CoreText
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
        guard let base = UIFont(name: "RedHatDisplay-Regular", size: 34) else {
            Issue.record("RedHatDisplay-Regular should be bundled")
            return
        }

        let defaultTraits = UITraitCollection(preferredContentSizeCategory: .large)
        let largeTraits = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
        let metrics = UIFontMetrics(forTextStyle: .largeTitle)

        let defaultSize = metrics.scaledFont(for: base, compatibleWith: defaultTraits).pointSize
        let largeSize = metrics.scaledFont(for: base, compatibleWith: largeTraits).pointSize

        #expect(largeSize > defaultSize)
    }

    @Test func `display variable weight axis instantiates heavy weights`() {
        guard UIFont(name: "RedHatDisplay-Regular", size: 15) != nil else {
            Issue.record("RedHatDisplay-Regular should be bundled")
            return
        }

        let weightAxis = NSNumber(value: 2_003_265_652) // "wght"
        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: "RedHatDisplay-Regular",
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [weightAxis: 900],
        ])
        let font = UIFont(descriptor: descriptor, size: 15)
        let variations = font.fontDescriptor.object(
            forKey: kCTFontVariationAttribute as UIFontDescriptor.AttributeName) as? [NSNumber: Any]
        let weightValue = variations?[weightAxis] as? NSNumber

        #expect(weightValue?.doubleValue == 900)
    }
}
