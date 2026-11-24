import CoreGraphics
import Testing
@testable import OpenClawChatUI

struct ChatColumnLayoutTests {
    @Test
    func `one width rule sets margin, column and user bubble cap from the pane width`() {
        // pane: iPhone 402, the bubble-cap threshold 600, the margin threshold 700, iPad 13" landscape 1056.
        let cases: [(pane: CGFloat, margin: CGFloat, column: CGFloat, userBubbleMax: CGFloat)] = [
            (402, 16, 370, 0.82 * 370),
            (600, 16, 568, 0.82 * 568),
            (700, 24, 652, 0.68 * 652),
            (1056, 24, 768, 0.68 * 768),
        ]
        for expected in cases {
            let layout = ChatColumnLayout(paneWidth: expected.pane)
            #expect(layout.margin == expected.margin, "pane \(expected.pane)")
            #expect(layout.columnWidth == expected.column, "pane \(expected.pane)")
            #expect(abs(layout.userBubbleMaxWidth - expected.userBubbleMax) < 0.001, "pane \(expected.pane)")
        }
    }

    @Test
    func `an unmeasured pane keeps a full column instead of collapsing`() {
        let layout = ChatColumnLayout(paneWidth: 0)
        #expect(layout.columnWidth == ChatColumnLayout.maxColumnWidth)
    }
}
