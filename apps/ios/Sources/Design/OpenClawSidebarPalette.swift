import SwiftUI

/// Mirrors the Control UI dark sidebar tokens; iOS deliberately keeps this palette in both appearances.
enum OpenClawSidebarPalette {
    static let background = Color(red: 14 / 255, green: 17 / 255, blue: 22 / 255)
    static let elevated = Color(red: 25 / 255, green: 28 / 255, blue: 36 / 255)
    static let selection = Color(red: 31 / 255, green: 35 / 255, blue: 48 / 255)
    static let hairline = Color(red: 30 / 255, green: 32 / 255, blue: 40 / 255)
    static let text = Color(red: 212 / 255, green: 212 / 255, blue: 216 / 255)
    static let textStrong = Color(red: 244 / 255, green: 244 / 255, blue: 245 / 255)
    static let muted = Color(red: 139 / 255, green: 139 / 255, blue: 148 / 255)
    static let accent = OpenClawBrand.accent
}
