import SwiftUI
import Testing
import UIKit
@testable import OpenClawChatUI

/// Resolves every chat text role the way SwiftUI renders it, at every Dynamic Type setting, and checks
/// the reading size: body is the system body at the default setting, Dynamic Type moves it both ways,
/// and no role resolves under 11 points. The composer draft has its own test in ChatTypographyScaleTests.
///
/// Inter follows `relativeTo:` along UIFontMetrics' curve for custom fonts. That curve equals the San
/// Francisco table at the default setting only (Inter body is 15 pt at xS and 37 pt at AX3, where the
/// system body is 14 and 40), so body is pinned to the system mechanism, not to the SF table.
extension OpenClawTypographyTests {
    @MainActor
    @Test func `chat text roles follow Dynamic Type and never render under 11 points`() throws {
        let inter = try #require(UIFont(name: "Inter-Regular", size: 17), "The app host registers Inter")
        let roles: [(name: String, font: Font)] = [
            ("body", OpenClawChatTypography.body),
            ("callout (thinking)", OpenClawChatTypography.callout),
            ("footnote (actions glyphs)", OpenClawChatTypography.footnote),
            ("footnote semibold", OpenClawChatTypography.footnoteSemiBold),
            ("caption", OpenClawChatTypography.caption),
            ("caption semibold", OpenClawChatTypography.captionSemiBold),
            ("caption2 (timestamp)", OpenClawChatTypography.caption2),
            ("headline", OpenClawChatTypography.headline),
            ("heading 1", OpenClawChatTypography.heading(level: 1)),
            ("heading 2", OpenClawChatTypography.heading(level: 2)),
            ("heading 3", OpenClawChatTypography.heading(level: 3)),
            ("heading 4", OpenClawChatTypography.heading(level: 4)),
            ("heading 5", OpenClawChatTypography.heading(level: 5)),
            ("heading 6", OpenClawChatTypography.heading(level: 6)),
            ("reaction emoji", OpenClawChatTypography.reactionEmoji),
            ("reaction count", OpenClawChatTypography.reactionCount),
            ("code block", OpenClawChatTypography.mono(size: 13, relativeTo: .footnote)),
            ("inline code", OpenClawChatTypography.mono(size: 12, relativeTo: .footnote)),
            ("tool detail", OpenClawChatTypography.mono(size: 10, relativeTo: .caption2)),
            ("audio time", OpenClawChatTypography.mono(size: 11, relativeTo: .caption)),
        ]
        var body: [DynamicTypeSize: CGFloat] = [:]
        for size in DynamicTypeSize.allCases {
            var environment = EnvironmentValues()
            environment.dynamicTypeSize = size
            let category = UIContentSizeCategory(size)
            let traits = UITraitCollection(preferredContentSizeCategory: category)
            let system = UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize
            let mechanism = UIFontMetrics(forTextStyle: .body).scaledFont(for: inter, compatibleWith: traits).pointSize
            print("CHAT_TYPE setting=\(size) role=system body (SF) points=\(system)")
            for role in roles {
                let points = role.font.resolve(in: environment.fontResolutionContext).pointSize
                print("CHAT_TYPE setting=\(size) role=\(role.name) points=\(points)")
                #expect(points >= 11, "\(role.name) resolves to \(points) pt at \(size)")
                if role.name == "body" {
                    body[size] = points
                    #expect(points == mechanism, "body follows UIFontMetrics for Inter at \(size)")
                }
            }
        }
        #expect(body[.large] == 17)
        #expect(try #require(body[.xSmall]) < 17 && (try #require(body[.accessibility3])) > 17)
    }
}
