import SwiftUI
import Testing
import UIKit
@testable import OpenClawChatUI

@MainActor
struct ChatTranscriptTypographyTests {
    @Test func `message body and headings are smaller than their sheet counterparts`() {
        var environment = EnvironmentValues()
        environment.dynamicTypeSize = .large
        let response = AssistantTextSegment.Kind.response.markdownTypography
        let reader = ChatMarkdownRenderer(text: "Reply", context: .assistant, variant: .standard, textColor: .primary)
        func points(_ font: Font) -> CGFloat {
            font.resolve(in: environment.fontResolutionContext).pointSize
        }

        #expect(points(response.proseFont) == 15)
        #expect(points(reader.typography.proseFont) == 17)
        #expect(points(OpenClawChatTypography.body) == 17)
        #expect((1...6).map { points(response.headingFont(level: $0)) } == [22, 19, 17, 15, 15, 15])
        #expect((1...6).map { points(reader.typography.headingFont(level: $0)) } == [24, 21, 19, 17, 16, 15])
    }

    @Test func `message text follows the body curve at every setting`() {
        let font = AssistantTextSegment.Kind.response.markdownTypography.proseFont
        let base = UIFont.systemFont(ofSize: 15)
        for size in DynamicTypeSize.allCases {
            var environment = EnvironmentValues()
            environment.dynamicTypeSize = size
            let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
            let expected = UIFontMetrics(forTextStyle: .body).scaledFont(for: base, compatibleWith: traits).pointSize
            let actual = font.resolve(in: environment.fontResolutionContext).pointSize
            #expect(actual == expected)
            #expect(actual >= 11)
        }
    }
}
