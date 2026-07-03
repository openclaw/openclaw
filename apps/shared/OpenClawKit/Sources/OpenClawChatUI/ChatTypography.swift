import Foundation
import SwiftUI

enum OpenClawChatTypography {
    static var title3: Font {
        display(size: 22, weight: .bold, relativeTo: .title2)
    }

    static var title3SemiBold: Font {
        display(size: 22, weight: .semibold, relativeTo: .title2)
    }

    static var headline: Font {
        display(size: 17, weight: .semibold, relativeTo: .headline)
    }

    static var callout: Font {
        body(size: 16, weight: .regular, relativeTo: .callout)
    }

    static var body: Font {
        body(size: 17, weight: .regular, relativeTo: .body)
    }

    static var footnote: Font {
        body(size: 13, weight: .regular, relativeTo: .footnote)
    }

    static var footnoteSemiBold: Font {
        body(size: 13, weight: .semibold, relativeTo: .footnote)
    }

    static var caption: Font {
        body(size: 12, weight: .regular, relativeTo: .caption)
    }

    static var captionSemiBold: Font {
        body(size: 12, weight: .semibold, relativeTo: .caption)
    }

    static var caption2: Font {
        body(size: 11, weight: .regular, relativeTo: .caption2)
    }

    static func avatar(size: CGFloat) -> Font {
        body(size: size, weight: .bold, relativeTo: .caption)
    }

    static func body(size: CGFloat, weight: Font.Weight, relativeTo textStyle: Font.TextStyle) -> Font {
        #if os(iOS)
        Font.custom(Self.bodyPostScriptName, size: size, relativeTo: textStyle).weight(weight)
        #else
        Font.system(size: size, weight: weight)
        #endif
    }

    static func display(size: CGFloat, weight: Font.Weight, relativeTo textStyle: Font.TextStyle) -> Font {
        #if os(iOS)
        Font.custom(Self.displayPostScriptName, size: size, relativeTo: textStyle).weight(weight)
        #else
        Font.system(size: size, weight: weight)
        #endif
    }

    static func mono(size: CGFloat, weight: Font.Weight = .regular, relativeTo textStyle: Font.TextStyle) -> Font {
        #if os(iOS)
        let name = weight == .semibold ? Self.monoSemiBoldPostScriptName : Self.monoPostScriptName
        return Font.custom(name, size: size, relativeTo: textStyle)
        #else
        return Font.system(size: size, weight: weight, design: .monospaced)
        #endif
    }

    private static let displayPostScriptName = "RedHatDisplay-Regular"
    private static let bodyPostScriptName = "Inter-Regular"
    private static let monoPostScriptName = "JetBrainsMono-Regular"
    private static let monoSemiBoldPostScriptName = "JetBrainsMono-SemiBold"
}
