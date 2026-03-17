import SwiftUI

struct MobileColors {
    let surface: Color
    let surfaceStrong: Color
    let cardSurface: Color
    let border: Color
    let borderStrong: Color
    let text: Color
    let textSecondary: Color
    let textTertiary: Color
    let accent: Color
    let accentSoft: Color
    let accentBorderStrong: Color
    let success: Color
    let successSoft: Color
    let warning: Color
    let warningSoft: Color
    let danger: Color
    let dangerSoft: Color
    let codeBg: Color
    let codeText: Color
    let codeBorder: Color
    let codeAccent: Color
    let chipBorderConnected: Color
    let chipBorderConnecting: Color
    let chipBorderWarning: Color
    let chipBorderError: Color
    let glassStroke: Color
    let glassShadow: Color
    let overlayFill: Color
}

func lightMobileColors() -> MobileColors {
    MobileColors(
        surface: Color(red: 0xF6 / 255, green: 0xF7 / 255, blue: 0xFA / 255),
        surfaceStrong: Color(red: 0xEC / 255, green: 0xEE / 255, blue: 0xF3 / 255),
        cardSurface: .white,
        border: Color(red: 0xE5 / 255, green: 0xE7 / 255, blue: 0xEC / 255),
        borderStrong: Color(red: 0xD6 / 255, green: 0xDA / 255, blue: 0xE2 / 255),
        text: Color(red: 0x17 / 255, green: 0x18 / 255, blue: 0x1C / 255),
        textSecondary: Color(red: 0x5D / 255, green: 0x64 / 255, blue: 0x72 / 255),
        textTertiary: Color(red: 0x99 / 255, green: 0xA0 / 255, blue: 0xAE / 255),
        accent: Color(red: 0x1D / 255, green: 0x5D / 255, blue: 0xD8 / 255),
        accentSoft: Color(red: 0xEC / 255, green: 0xF3 / 255, blue: 0xFF / 255),
        accentBorderStrong: Color(red: 0x18 / 255, green: 0x4D / 255, blue: 0xAF / 255),
        success: Color(red: 0x2F / 255, green: 0x8C / 255, blue: 0x5A / 255),
        successSoft: Color(red: 0xEE / 255, green: 0xF9 / 255, blue: 0xF3 / 255),
        warning: Color(red: 0xC8 / 255, green: 0x84 / 255, blue: 0x1A / 255),
        warningSoft: Color(red: 0xFF / 255, green: 0xF8 / 255, blue: 0xEC / 255),
        danger: Color(red: 0xD0 / 255, green: 0x4B / 255, blue: 0x4B / 255),
        dangerSoft: Color(red: 0xFF / 255, green: 0xF2 / 255, blue: 0xF2 / 255),
        codeBg: Color(red: 0x15 / 255, green: 0x17 / 255, blue: 0x1B / 255),
        codeText: Color(red: 0xE8 / 255, green: 0xEA / 255, blue: 0xEE / 255),
        codeBorder: Color(red: 0x2B / 255, green: 0x2E / 255, blue: 0x35 / 255),
        codeAccent: Color(red: 0x3F / 255, green: 0xC9 / 255, blue: 0x7A / 255),
        chipBorderConnected: Color(red: 0xCF / 255, green: 0xEB / 255, blue: 0xD8 / 255),
        chipBorderConnecting: Color(red: 0xD5 / 255, green: 0xE2 / 255, blue: 0xFA / 255),
        chipBorderWarning: Color(red: 0xEE / 255, green: 0xD8 / 255, blue: 0xB8 / 255),
        chipBorderError: Color(red: 0xF3 / 255, green: 0xC8 / 255, blue: 0xC8 / 255),
        glassStroke: .black,
        glassShadow: Color(white: 0, opacity: 0.12),
        overlayFill: .white
    )
}

func darkMobileColors() -> MobileColors {
    MobileColors(
        surface: Color(red: 0x1A / 255, green: 0x1C / 255, blue: 0x20 / 255),
        surfaceStrong: Color(red: 0x24 / 255, green: 0x26 / 255, blue: 0x2B / 255),
        cardSurface: Color(red: 0x1E / 255, green: 0x20 / 255, blue: 0x24 / 255),
        border: Color(red: 0x2E / 255, green: 0x30 / 255, blue: 0x38 / 255),
        borderStrong: Color(red: 0x3A / 255, green: 0x3D / 255, blue: 0x46 / 255),
        text: Color(red: 0xE4 / 255, green: 0xE5 / 255, blue: 0xEA / 255),
        textSecondary: Color(red: 0xA0 / 255, green: 0xA6 / 255, blue: 0xB4 / 255),
        textTertiary: Color(red: 0x6B / 255, green: 0x72 / 255, blue: 0x80 / 255),
        accent: Color(red: 0x6E / 255, green: 0xA8 / 255, blue: 0xFF / 255),
        accentSoft: Color(red: 0x1A / 255, green: 0x2A / 255, blue: 0x44 / 255),
        accentBorderStrong: Color(red: 0x5B / 255, green: 0x93 / 255, blue: 0xE8 / 255),
        success: Color(red: 0x5F / 255, green: 0xBB / 255, blue: 0x85 / 255),
        successSoft: Color(red: 0x15 / 255, green: 0x2E / 255, blue: 0x22 / 255),
        warning: Color(red: 0xE8 / 255, green: 0xA8 / 255, blue: 0x44 / 255),
        warningSoft: Color(red: 0x2E / 255, green: 0x22 / 255, blue: 0x12 / 255),
        danger: Color(red: 0xE8 / 255, green: 0x70 / 255, blue: 0x70 / 255),
        dangerSoft: Color(red: 0x2E / 255, green: 0x16 / 255, blue: 0x16 / 255),
        codeBg: Color(red: 0x11 / 255, green: 0x13 / 255, blue: 0x17 / 255),
        codeText: Color(red: 0xE8 / 255, green: 0xEA / 255, blue: 0xEE / 255),
        codeBorder: Color(red: 0x2B / 255, green: 0x2E / 255, blue: 0x35 / 255),
        codeAccent: Color(red: 0x3F / 255, green: 0xC9 / 255, blue: 0x7A / 255),
        chipBorderConnected: Color(red: 0x1E / 255, green: 0x4A / 255, blue: 0x30 / 255),
        chipBorderConnecting: Color(red: 0x1E / 255, green: 0x33 / 255, blue: 0x58 / 255),
        chipBorderWarning: Color(red: 0x3E / 255, green: 0x30 / 255, blue: 0x18 / 255),
        chipBorderError: Color(red: 0x3E / 255, green: 0x1E / 255, blue: 0x1E / 255),
        glassStroke: .white,
        glassShadow: Color(white: 0, opacity: 0.25),
        overlayFill: .black
    )
}

private struct MobileColorsKey: EnvironmentKey {
    static let defaultValue: MobileColors = darkMobileColors()
}

extension EnvironmentValues {
    var mobileColors: MobileColors {
        get { self[MobileColorsKey.self] }
        set { self[MobileColorsKey.self] = newValue }
    }
}
