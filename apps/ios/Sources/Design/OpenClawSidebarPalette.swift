import SwiftUI
import UIKit

/// Sidebar surface tokens mirroring the mobile-exp prototype palette; the
/// drawer follows the app appearance (owner decision superseding always-dark).
enum OpenClawSidebarPalette {
    static let background = adaptive(light: 0xFAFAFA, dark: 0x000000)
    static let elevated = adaptive(light: 0xF2F2F2, dark: 0x1A1A1A)
    static let selection = adaptive(light: 0xEDEDED, dark: 0x232327)
    static let text = adaptive(light: 0x171717, dark: 0xEDEDED)
    static let textStrong = adaptive(light: 0x171717, dark: 0xEDEDED)
    static let muted = adaptive(light: 0x8F8F8F, dark: 0x8F8F8F)
    static let accent = OpenClawBrand.accent

    static let hairline = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.14)
            : UIColor(white: 0, alpha: 0.08)
    })

    /// Portable theme tokens for the embedded conversation, resolved from the
    /// same native owners as the sidebar, never from a separate web preference.
    @MainActor
    static var conversationTheme: [String: [String: String]] {
        ["light": self.conversationPalette(.light), "dark": self.conversationPalette(.dark)]
    }

    @MainActor
    private static func conversationPalette(_ style: UIUserInterfaceStyle) -> [String: String] {
        let traits = UITraitCollection(userInterfaceStyle: style)
        func css(_ color: Color) -> String {
            let resolved = UIColor(color).resolvedColor(with: traits)
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            return String(
                format: "#%02x%02x%02x%02x",
                Int((red * 255).rounded()),
                Int((green * 255).rounded()),
                Int((blue * 255).rounded()),
                Int((alpha * 255).rounded()))
        }
        return [
            "background": css(self.background), "foreground": css(self.text),
            "card": css(self.elevated), "card-foreground": css(self.textStrong),
            "popover": css(self.elevated), "popover-foreground": css(self.textStrong),
            "primary": css(OpenClawBrand.accentFill), "primary-foreground": css(.white),
            "secondary": css(self.selection), "secondary-foreground": css(self.text),
            "muted": css(self.selection), "muted-foreground": css(self.muted),
            "accent": css(self.accent), "accent-foreground": css(self.background),
            "destructive": css(OpenClawBrand.danger), "destructive-foreground": css(self.background),
            "border": css(self.hairline), "input": css(self.selection), "ring": css(self.accent),
        ]
    }

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1)
        })
    }
}
