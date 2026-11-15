import Foundation
import OpenClawChatUI

struct AppThemePaletteSeed {
    let canvas: UInt32
    let surface: UInt32
    let raised: UInt32
    let pressed: UInt32
    let accent: UInt32
    let border: UInt32
    let borderStrong: UInt32
    let text: UInt32
    let muted: UInt32
    let primary: UInt32
    let primaryText: UInt32
    let secondary: UInt32
}

extension AppThemeFamily {
    /// Mirrors Android familyColors/clawColorsForTheme, including the Claw defaults.
    func palette(dark: Bool, accentHex: String?) -> OpenClawNativePalette {
        let seed = self.seed(dark: dark)
        let override = accentHex.flatMap { UInt32($0.dropFirst(), radix: 16) }.map { $0 | 0xFF00_0000 }
        let accent = override ?? seed.accent
        var colors: [OpenClawNativePalette.Token: UInt32] = [
            .canvas: seed.canvas, .surface: seed.surface, .raised: seed.raised, .pressed: seed.pressed,
            .accent: accent, .border: seed.border, .borderStrong: seed.borderStrong,
            .text: seed.text, .muted: seed.muted, .secondary: seed.secondary,
            .primary: override ?? seed.primary,
            .primaryText: override.map { Self.luminance($0) > 0.179 ? 0xFF00_0000 : 0xFFFF_FFFF } ?? seed.primaryText,
            .subtle: self == .claw ? (dark ? 0xFF8B_8B94 : 0xFF78_7885) : Self.alpha(seed.muted, 0.82),
            .codeBackground: self == .claw ? (dark ? 0xFF0A_0C10 : 0xFFF1_F1F4) : seed.canvas,
            .userMessageSurface: Self.composite(
                accent,
                alpha: self == .claw && !dark && override == nil ? 38 / 255.0 : (dark ? 0.12 : 0.15),
                over: seed.canvas),
        ]
        if override != nil {
            colors[.accentSoft] = Self.composite(accent, alpha: dark ? 0.25 : 0.08, over: seed.canvas)
            // Compose lerp interpolates in Oklab. Mixing toward black scales linear RGB by t³.
            colors[.accentBorder] = Self.darken(accent, factor: pow(0.88, 3))
        } else if self == .claw {
            colors[.accentSoft] = (accent & 0x00FF_FFFF) | 0x1A00_0000
            colors[.accentBorder] = dark ? 0xFFD1_3C3C : 0xFFA3_2C2C
        } else {
            colors[.accentSoft] = Self.alpha(accent, dark ? 0.12 : 0.10)
            colors[.accentBorder] = Self.alpha(accent, dark ? 0.55 : 0.65)
        }
        return OpenClawNativePalette(colors: colors)
    }

    private static func alpha(_ color: UInt32, _ alpha: Double) -> UInt32 {
        (color & 0x00FF_FFFF) | (UInt32((alpha * 255).rounded()) << 24)
    }

    private static func composite(_ color: UInt32, alpha: Double, over background: UInt32) -> UInt32 {
        [16, 8, 0].reduce(UInt32(0xFF00_0000)) { result, shift in
            let value = Double((color >> shift) & 255) * alpha + Double((background >> shift) & 255) * (1 - alpha)
            return result | (UInt32(value.rounded()) << shift)
        }
    }

    private static func linear(_ channel: Double) -> Double {
        channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
    }

    private static func luminance(_ color: UInt32) -> Double {
        zip([16, 8, 0], [0.2126, 0.7152, 0.0722]).reduce(0) { sum, pair in
            sum + Self.linear(Double((color >> pair.0) & 255) / 255) * pair.1
        }
    }

    private static func darken(_ color: UInt32, factor: Double) -> UInt32 {
        [16, 8, 0].reduce(UInt32(0xFF00_0000)) { result, shift in
            let linear = Self.linear(Double((color >> shift) & 255) / 255) * factor
            let encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * pow(linear, 1 / 2.4) - 0.055
            return result | (UInt32((encoded * 255).rounded()) << shift)
        }
    }
}

extension OpenClawNativePalette {
    /// The native resolver supplies values, never arbitrary CSS or a second palette.
    var webVariables: [String: String] {
        let tokens: [String: Token] = [
            "--bg": .canvas, "--bg-content": .canvas, "--panel": .surface,
            "--bg-elevated": .raised, "--card": .surface, "--popover": .raised,
            "--bg-hover": .pressed, "--bg-accent": .pressed, "--panel-strong": .raised,
            "--chrome": .canvas, "--chrome-strong": .surface,
            "--text": .text, "--text-strong": .text, "--chat-text": .text,
            "--card-foreground": .text, "--popover-foreground": .text,
            "--muted": .muted, "--muted-strong": .muted, "--muted-foreground": .muted,
            "--border": .border, "--border-strong": .borderStrong,
            "--accent": .accent, "--accent-hover": .accent, "--accent-active": .accent,
            "--accent-subtle": .accentSoft, "--accent-muted": .accentBorder,
            "--primary": .primary, "--primary-hover": .primary, "--primary-active": .primary,
            "--primary-foreground": .primaryText, "--accent-foreground": .primaryText,
            "--chat-send-bg": .primary, "--chat-send-foreground": .primaryText,
            "--chat-user-bg": .userMessageSurface, "--chat-user-text": .text,
            "--ring": .accent, "--code-bg": .codeBackground,
        ]
        return tokens.reduce(into: [:]) { result, entry in
            guard let argb = self.colors[entry.value] else { return }
            result[entry.key] = String(format: "#%06x%02x", argb & 0x00FF_FFFF, argb >> 24)
        }
    }
}
