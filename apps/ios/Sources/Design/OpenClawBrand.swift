import SwiftUI

enum AppAppearancePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    static let storageKey = "appearance.preference"

    static var launchArgumentPreference: AppAppearancePreference? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-appearance") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }
        return AppAppearancePreference(rawValue: arguments[valueIndex].lowercased())
    }

    var id: String {
        self.rawValue
    }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var systemImage: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max"
        case .dark: "moon.stars"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    var userInterfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }
}

enum OpenClawBrand {
    // Brand — Claw Red / Claw Teal from design guide
    static let uiAccent = adaptiveUIColor(light: (232, 48, 42), dark: (232, 48, 42))
    static let uiAccentHot = adaptiveUIColor(light: (240, 69, 64), dark: (240, 69, 64))
    static let uiAccentPressed = adaptiveUIColor(light: (184, 34, 32), dark: (184, 34, 32))
    static let uiTeal = adaptiveUIColor(light: (0, 196, 176), dark: (0, 196, 176))

    // Surfaces — dark palette from design guide; light derives from system-adjacent neutrals
    static let uiVoid = adaptiveUIColor(light: (246, 247, 249), dark: (11, 12, 17))
    static let uiObsidian = adaptiveUIColor(light: (255, 255, 255), dark: (19, 21, 28))
    static let uiSlate = adaptiveUIColor(light: (242, 243, 247), dark: (28, 31, 43))
    static let uiStone = adaptiveUIColor(light: (235, 236, 240), dark: (37, 40, 56))

    // Text hierarchy
    static let uiTextPrimary = adaptiveUIColor(light: (11, 12, 17), dark: (242, 239, 232))
    static let uiTextSecondary = adaptiveUIColor(light: (90, 94, 110), dark: (168, 170, 191))
    static let uiTextTertiary = adaptiveUIColor(light: (122, 127, 148), dark: (122, 127, 148))
    static let uiTextDisabled = adaptiveUIColor(light: (180, 184, 198), dark: (61, 65, 87))

    // Semantic
    static let uiOK = adaptiveUIColor(light: (19, 122, 62), dark: (52, 211, 153))
    static let uiWarn = adaptiveUIColor(light: (180, 83, 9), dark: (245, 158, 11))
    static let uiDanger = adaptiveUIColor(light: (185, 28, 28), dark: (255, 59, 59))
    static let uiInfo = adaptiveUIColor(light: (37, 99, 235), dark: (96, 165, 250))

    static let accent = Color(uiColor: Self.uiAccent)
    static let accentHot = Color(uiColor: Self.uiAccentHot)
    static let accentPressed = Color(uiColor: Self.uiAccentPressed)
    static let accentGhost = accent.opacity(0.12)
    static let teal = Color(uiColor: Self.uiTeal)
    static let tealGhost = teal.opacity(0.12)

    static let void = Color(uiColor: Self.uiVoid)
    static let obsidian = Color(uiColor: Self.uiObsidian)
    static let slate = Color(uiColor: Self.uiSlate)
    static let stone = Color(uiColor: Self.uiStone)

    static let textPrimary = Color(uiColor: Self.uiTextPrimary)
    static let textSecondary = Color(uiColor: Self.uiTextSecondary)
    static let textTertiary = Color(uiColor: Self.uiTextTertiary)
    static let textDisabled = Color(uiColor: Self.uiTextDisabled)

    static let danger = Color(uiColor: Self.uiDanger)
    static let error = danger
    static let ok = Color(uiColor: Self.uiOK)
    static let warn = Color(uiColor: Self.uiWarn)
    static let info = Color(uiColor: Self.uiInfo)

    static let graphite = void
    static let graphiteElevated = obsidian

    static var sheetBackground: LinearGradient {
        LinearGradient(
            colors: [
                graphite,
                graphiteElevated.opacity(0.96),
                Color(uiColor: .systemBackground),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }

    private static func adaptiveUIColor(
        light: (red: CGFloat, green: CGFloat, blue: CGFloat),
        dark: (red: CGFloat, green: CGFloat, blue: CGFloat)) -> UIColor
    {
        UIColor { traits in
            let components = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: components.red / 255,
                green: components.green / 255,
                blue: components.blue / 255,
                alpha: 1)
        }
    }
}

extension View {
    func openClawSheetChrome() -> some View {
        self
            .tint(OpenClawBrand.accent)
            .background {
                OpenClawBrand.sheetBackground
                    .ignoresSafeArea()
            }
    }
}
