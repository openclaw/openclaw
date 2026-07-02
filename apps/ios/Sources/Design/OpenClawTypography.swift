import SwiftUI
import UIKit

enum OpenClawType {
    // MARK: - Display — Plus Jakarta Sans

    static var title1: Font {
        scaledDisplay(name: Display.extraBold, size: 34, relativeTo: .largeTitle)
    }

    static var title2: Font {
        scaledDisplay(name: Display.bold, size: 28, relativeTo: .title1)
    }

    static var title3: Font {
        scaledDisplay(name: Display.bold, size: 22, relativeTo: .title2)
    }

    static var headline: Font {
        scaledDisplay(name: Display.semiBold, size: 17, relativeTo: .headline)
    }

    // MARK: - Body — DM Sans

    static var body: Font {
        scaledBody(name: Body.regular, size: 17, relativeTo: .body)
    }

    static var callout: Font {
        scaledBody(name: Body.regular, size: 16, relativeTo: .callout)
    }

    static var subhead: Font {
        scaledBody(name: Body.medium, size: 15, relativeTo: .subheadline)
    }

    static var subheadSemiBold: Font {
        scaledDisplay(name: Display.semiBold, size: 15, relativeTo: .subheadline)
    }

    static var footnote: Font {
        scaledBody(name: Body.regular, size: 13, relativeTo: .footnote)
    }

    static var footnoteMedium: Font {
        scaledBody(name: Body.medium, size: 13, relativeTo: .footnote)
    }

    static var footnoteSemiBold: Font {
        scaledBody(name: Body.semiBold, size: 13, relativeTo: .footnote)
    }

    static var caption: Font {
        scaledBody(name: Body.regular, size: 12, relativeTo: .caption1)
    }

    static var captionMedium: Font {
        scaledBody(name: Body.medium, size: 12, relativeTo: .caption1)
    }

    static var captionSemiBold: Font {
        scaledBody(name: Body.semiBold, size: 12, relativeTo: .caption1)
    }

    static var caption2: Font {
        scaledBody(name: Body.regular, size: 11, relativeTo: .caption2)
    }

    static var caption2Medium: Font {
        scaledBody(name: Body.medium, size: 11, relativeTo: .caption2)
    }

    static var caption2SemiBold: Font {
        scaledBody(name: Body.semiBold, size: 11, relativeTo: .caption2)
    }

    static var caption2Bold: Font {
        scaledDisplay(name: Display.bold, size: 11, relativeTo: .caption2)
    }

    static var title2SemiBold: Font {
        scaledDisplay(name: Display.semiBold, size: 28, relativeTo: .title1)
    }

    // MARK: - Mono — JetBrains Mono

    static var mono: Font {
        scaledMono(name: Mono.regular, size: 14, relativeTo: .body)
    }

    static var monoSmall: Font {
        scaledMono(name: Mono.regular, size: 12, relativeTo: .caption1)
    }

    static var monoFootnote: Font {
        scaledMono(name: Mono.regular, size: 13, relativeTo: .footnote)
    }

    static var monoHeadline: Font {
        scaledMono(name: Mono.medium, size: 17, relativeTo: .headline)
    }

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
