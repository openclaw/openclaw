import CoreText
import SwiftUI
import UIKit

enum OpenClawType {
    // MARK: - Display — Red Hat Display

    static var title1: Font {
        scaledDisplay(weight: Display.heavyTitle, size: 34, relativeTo: .largeTitle)
    }

    static var title2: Font {
        scaledDisplay(weight: Display.heavyTitle, size: 28, relativeTo: .title1)
    }

    static var title3: Font {
        scaledDisplay(weight: Display.opticalBold, size: 22, relativeTo: .title2)
    }

    static var title3SemiBold: Font {
        scaledDisplay(weight: Display.opticalSemiBold, size: 22, relativeTo: .title2)
    }

    static var headline: Font {
        scaledDisplay(weight: Display.opticalSemiBold, size: 17, relativeTo: .headline)
    }

    static var headlineBold: Font {
        scaledDisplay(weight: Display.opticalBold, size: 17, relativeTo: .headline)
    }

    static func display(size: CGFloat, weight: CGFloat, relativeTo textStyle: UIFont.TextStyle) -> Font {
        self.scaledDisplay(weight: weight, size: size, relativeTo: textStyle)
    }

    // MARK: - Body — Inter

    static var body: Font {
        scaledBody(weight: Body.regular, size: 17, relativeTo: .body)
    }

    static var callout: Font {
        scaledBody(weight: Body.regular, size: 16, relativeTo: .callout)
    }

    static var subhead: Font {
        scaledBody(weight: Body.regular, size: 15, relativeTo: .subheadline)
    }

    static var subheadMedium: Font {
        scaledBody(weight: Body.medium, size: 15, relativeTo: .subheadline)
    }

    static var subheadSemiBold: Font {
        scaledDisplay(weight: Display.opticalSemiBold, size: 15, relativeTo: .subheadline)
    }

    static var subheadBold: Font {
        scaledDisplay(weight: Display.opticalBold, size: 15, relativeTo: .subheadline)
    }

    static var footnote: Font {
        scaledBody(weight: Body.regular, size: 13, relativeTo: .footnote)
    }

    static var footnoteMedium: Font {
        scaledBody(weight: Body.medium, size: 13, relativeTo: .footnote)
    }

    static var footnoteSemiBold: Font {
        scaledBody(weight: Body.semiBold, size: 13, relativeTo: .footnote)
    }

    static var caption: Font {
        scaledBody(weight: Body.regular, size: 12, relativeTo: .caption1)
    }

    static var captionMedium: Font {
        scaledBody(weight: Body.medium, size: 12, relativeTo: .caption1)
    }

    static var captionSemiBold: Font {
        scaledBody(weight: Body.semiBold, size: 12, relativeTo: .caption1)
    }

    static var captionBold: Font {
        scaledBody(weight: Body.bold, size: 12, relativeTo: .caption1)
    }

    static func body(size: CGFloat, weight: CGFloat, relativeTo textStyle: UIFont.TextStyle) -> Font {
        self.scaledBody(weight: weight, size: size, relativeTo: textStyle)
    }

    static func avatar(size: CGFloat) -> Font {
        self.scaledBody(weight: Body.bold, size: size, relativeTo: .caption1)
    }

    static var caption2: Font {
        scaledBody(weight: Body.regular, size: 11, relativeTo: .caption2)
    }

    static var caption2Medium: Font {
        scaledBody(weight: Body.medium, size: 11, relativeTo: .caption2)
    }

    static var caption2SemiBold: Font {
        scaledBody(weight: Body.semiBold, size: 11, relativeTo: .caption2)
    }

    static var caption2Bold: Font {
        scaledDisplay(weight: Display.opticalBold, size: 11, relativeTo: .caption2)
    }

    static var title2SemiBold: Font {
        scaledDisplay(weight: Display.opticalSemiBold, size: 28, relativeTo: .title1)
    }

    // MARK: - Mono — JetBrains Mono

    static var mono: Font {
        scaledMono(name: Mono.regular, size: 14, relativeTo: .body)
    }

    static var monoSmall: Font {
        scaledMono(name: Mono.regular, size: 12, relativeTo: .caption1)
    }

    static var monoSmallMedium: Font {
        scaledMono(name: Mono.medium, size: 12, relativeTo: .caption1)
    }

    static var monoCaption2: Font {
        scaledMono(name: Mono.regular, size: 11, relativeTo: .caption2)
    }

    static var monoFootnote: Font {
        scaledMono(name: Mono.regular, size: 13, relativeTo: .footnote)
    }

    static var monoHeadline: Font {
        scaledMono(name: Mono.medium, size: 17, relativeTo: .headline)
    }

    /// PostScript names for bundled fonts. Keep aligned with `UIAppFonts` in `project.yml`.
    static let registeredPostScriptNames: [String] = [
        Display.postScriptName,
        Body.postScriptName,
        Body.italicPostScriptName,
        Mono.regular,
        Mono.medium,
        Mono.semiBold,
    ]

    private enum Display {
        static let postScriptName = "RedHatDisplay-Regular"
        static let opticalSemiBold: CGFloat = 650
        static let opticalBold: CGFloat = 750
        static let heavyTitle: CGFloat = 800
    }

    private enum Body {
        static let postScriptName = "Inter-Regular"
        static let italicPostScriptName = "Inter-Italic"
        static let regular: CGFloat = 400
        static let medium: CGFloat = 500
        static let semiBold: CGFloat = 600
        static let bold: CGFloat = 700
    }

    private enum Mono {
        static let regular = "JetBrainsMono-Regular"
        static let medium = "JetBrainsMono-Medium"
        static let semiBold = "JetBrainsMono-SemiBold"
    }

    private static let fontWeightAxis = NSNumber(value: 2_003_265_652) // "wght"
    private static let opticalSizeAxis = NSNumber(value: 1_869_640_570) // "opsz"

    private static func scaledDisplay(
        weight: CGFloat,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        self.scaledVariableFont(
            name: Display.postScriptName,
            size: size,
            relativeTo: textStyle,
            variations: [self.fontWeightAxis: weight])
    }

    private static func scaledBody(
        weight: CGFloat,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        self.scaledVariableFont(
            name: Body.postScriptName,
            size: size,
            relativeTo: textStyle,
            variations: [
                self.fontWeightAxis: weight,
                self.opticalSizeAxis: min(max(size, 14), 32),
            ])
    }

    private static func scaledMono(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        self.scaledFont(name: name, size: size, relativeTo: textStyle)
    }

    private static func scaledVariableFont(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle,
        variations: [NSNumber: CGFloat]) -> Font
    {
        guard UIFont(name: name, size: size) != nil else {
            let fallback = UIFont.systemFont(ofSize: size)
            let scaledFallback = UIFontMetrics(forTextStyle: textStyle).scaledFont(for: fallback)
            return Font(scaledFallback)
        }

        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: name,
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: variations,
        ])
        let base = UIFont(descriptor: descriptor, size: size)
        let scaled = UIFontMetrics(forTextStyle: textStyle).scaledFont(for: base)
        return Font(scaled)
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
