import SwiftUI
import UIKit

enum OpenClawType {
    // Display — Plus Jakarta Sans
    static let title1 = scaledDisplay(name: Display.extraBold, size: 34, relativeTo: .largeTitle)
    static let title2 = scaledDisplay(name: Display.bold, size: 28, relativeTo: .title1)
    static let title3 = scaledDisplay(name: Display.bold, size: 22, relativeTo: .title2)
    static let headline = scaledDisplay(name: Display.semiBold, size: 17, relativeTo: .headline)
    // Body — DM Sans
    static let body = scaledBody(name: Body.regular, size: 17, relativeTo: .body)
    static let callout = scaledBody(name: Body.regular, size: 16, relativeTo: .callout)
    static let subhead = scaledBody(name: Body.medium, size: 15, relativeTo: .subheadline)
    static let subheadSemiBold = scaledDisplay(name: Display.semiBold, size: 15, relativeTo: .subheadline)
    static let footnote = scaledBody(name: Body.regular, size: 13, relativeTo: .footnote)
    static let footnoteMedium = scaledBody(name: Body.medium, size: 13, relativeTo: .footnote)
    static let footnoteSemiBold = scaledBody(name: Body.semiBold, size: 13, relativeTo: .footnote)
    static let caption = scaledBody(name: Body.regular, size: 12, relativeTo: .caption1)
    static let captionMedium = scaledBody(name: Body.medium, size: 12, relativeTo: .caption1)
    static let captionSemiBold = scaledBody(name: Body.semiBold, size: 12, relativeTo: .caption1)
    static let caption2 = scaledBody(name: Body.regular, size: 11, relativeTo: .caption2)
    static let caption2Medium = scaledBody(name: Body.medium, size: 11, relativeTo: .caption2)
    static let caption2SemiBold = scaledBody(name: Body.semiBold, size: 11, relativeTo: .caption2)
    static let caption2Bold = scaledDisplay(name: Display.bold, size: 11, relativeTo: .caption2)
    static let title2SemiBold = scaledDisplay(name: Display.semiBold, size: 28, relativeTo: .title1)

    // Mono — JetBrains Mono
    static let mono = scaledMono(name: Mono.regular, size: 14, relativeTo: .body)
    static let monoSmall = scaledMono(name: Mono.regular, size: 12, relativeTo: .caption1)
    static let monoFootnote = scaledMono(name: Mono.regular, size: 13, relativeTo: .footnote)
    static let monoHeadline = scaledMono(name: Mono.medium, size: 17, relativeTo: .headline)

    /// PostScript names for bundled fonts. Keep aligned with `UIAppFonts` in `project.yml`.
    static let registeredPostScriptNames: [String] = [
        Display.light,
        Display.regular,
        Display.medium,
        Display.semiBold,
        Display.bold,
        Display.extraBold,
        Body.light,
        Body.regular,
        Body.italic,
        Body.medium,
        Body.semiBold,
        Mono.regular,
        Mono.medium,
        Mono.semiBold,
    ]

    private enum Display {
        static let light = "PlusJakartaSans-Light"
        static let regular = "PlusJakartaSans-Regular"
        static let medium = "PlusJakartaSans-Medium"
        static let semiBold = "PlusJakartaSans-SemiBold"
        static let bold = "PlusJakartaSans-Bold"
        static let extraBold = "PlusJakartaSans-ExtraBold"
    }

    private enum Body {
        static let light = "DMSans-Light"
        static let regular = "DMSans-Regular"
        static let italic = "DMSans-Italic"
        static let medium = "DMSans-Medium"
        static let semiBold = "DMSans-SemiBold"
    }

    private enum Mono {
        static let regular = "JetBrainsMono-Regular"
        static let medium = "JetBrainsMono-Medium"
        static let semiBold = "JetBrainsMono-SemiBold"
    }

    private static func scaledDisplay(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        self.scaledFont(name: name, size: size, relativeTo: textStyle)
    }

    private static func scaledBody(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        self.scaledFont(name: name, size: size, relativeTo: textStyle)
    }

    private static func scaledMono(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        self.scaledFont(name: name, size: size, relativeTo: textStyle)
    }

    private static func scaledFont(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        let base = UIFont(name: name, size: size) ?? UIFont.systemFont(ofSize: size)
        let scaled = UIFontMetrics(forTextStyle: textStyle).scaledFont(for: base)
        return Font(scaled)
    }
}
