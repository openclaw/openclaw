import SwiftUI
import Testing
@testable import OpenClawChatUI

#if os(iOS)
struct ChatCodeTextScaleTests {
    @Test func preferenceScalesCodeAfterDensityFloor() {
        for (scale, points): (CGFloat, CGFloat) in [(0.9, 9.9), (1, 11), (1.25, 13.75)] {
            #expect(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote, textScale: scale)
                == Font.custom("JetBrainsMono-Regular", size: points, relativeTo: .footnote))
        }
    }
}
#endif
