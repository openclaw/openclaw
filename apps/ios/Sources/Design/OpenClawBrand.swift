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
        rawValue
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

enum AppAccentColorPreference: String, CaseIterable, Identifiable {
    case coral
    case blue
    case purple
    case teal
    case orange
    case pink
    case indigo

    static let storageKey = "accent.color.preference"

    static var current: AppAccentColorPreference {
        let raw = UserDefaults.standard.string(forKey: Self.storageKey)
        return AppAccentColorPreference(rawValue: raw ?? "") ?? .coral
    }

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .coral: "Coral"
        case .blue: "Blue"
        case .purple: "Purple"
        case .teal: "Teal"
        case .orange: "Orange"
        case .pink: "Pink"
        case .indigo: "Indigo"
        }
    }

    var color: Color {
        Color(uiColor: self.uiColor)
    }

    var hotColor: Color {
        Color(uiColor: self.hotUIColor)
    }

    var uiColor: UIColor {
        Self.adaptiveUIColor(light: self.lightRGB, dark: self.darkRGB)
    }

    var hotUIColor: UIColor {
        Self.adaptiveUIColor(light: self.hotLightRGB, dark: self.hotDarkRGB)
    }

    var foregroundUIColor: UIColor {
        Self.adaptiveUIColor(light: self.foregroundLightRGB, dark: self.foregroundDarkRGB)
    }

    var hotForegroundUIColor: UIColor {
        Self.adaptiveUIColor(light: self.hotForegroundLightRGB, dark: self.hotForegroundDarkRGB)
    }

    private var lightRGB: RGB {
        switch self {
        case .coral: RGB(183, 56, 51)
        case .blue: RGB(37, 99, 235)
        case .purple: RGB(124, 58, 237)
        case .teal: RGB(13, 148, 136)
        case .orange: RGB(234, 88, 12)
        case .pink: RGB(219, 39, 119)
        case .indigo: RGB(79, 70, 229)
        }
    }

    private var darkRGB: RGB {
        switch self {
        case .coral: RGB(198, 62, 56)
        case .blue: RGB(96, 165, 250)
        case .purple: RGB(192, 132, 252)
        case .teal: RGB(45, 212, 191)
        case .orange: RGB(251, 146, 60)
        case .pink: RGB(244, 114, 182)
        case .indigo: RGB(129, 140, 248)
        }
    }

    private var hotLightRGB: RGB {
        switch self {
        case .coral: RGB(204, 75, 69)
        case .blue: RGB(59, 130, 246)
        case .purple: RGB(147, 78, 245)
        case .teal: RGB(20, 184, 166)
        case .orange: RGB(249, 115, 22)
        case .pink: RGB(236, 72, 153)
        case .indigo: RGB(99, 102, 241)
        }
    }

    private var hotDarkRGB: RGB {
        switch self {
        case .coral: RGB(232, 92, 86)
        case .blue: RGB(147, 197, 253)
        case .purple: RGB(216, 180, 254)
        case .teal: RGB(94, 234, 212)
        case .orange: RGB(253, 186, 116)
        case .pink: RGB(249, 168, 212)
        case .indigo: RGB(165, 180, 252)
        }
    }

    private var foregroundLightRGB: RGB {
        switch self {
        case .coral: RGB(183, 56, 51)
        case .blue: RGB(37, 99, 235)
        case .purple: RGB(124, 58, 237)
        case .teal: RGB(13, 148, 136)
        case .orange: RGB(234, 88, 12)
        case .pink: RGB(219, 39, 119)
        case .indigo: RGB(79, 70, 229)
        }
    }

    private var foregroundDarkRGB: RGB {
        switch self {
        case .coral: RGB(255, 107, 102)
        case .blue: RGB(147, 197, 253)
        case .purple: RGB(216, 180, 254)
        case .teal: RGB(94, 234, 212)
        case .orange: RGB(253, 186, 116)
        case .pink: RGB(249, 168, 212)
        case .indigo: RGB(165, 180, 252)
        }
    }

    private var hotForegroundLightRGB: RGB {
        switch self {
        case .coral: RGB(166, 55, 50)
        case .blue: RGB(29, 78, 216)
        case .purple: RGB(109, 40, 217)
        case .teal: RGB(15, 118, 110)
        case .orange: RGB(194, 65, 12)
        case .pink: RGB(190, 24, 93)
        case .indigo: RGB(67, 56, 202)
        }
    }

    private var hotForegroundDarkRGB: RGB {
        switch self {
        case .coral: RGB(255, 123, 115)
        case .blue: RGB(191, 219, 254)
        case .purple: RGB(233, 213, 255)
        case .teal: RGB(153, 246, 228)
        case .orange: RGB(254, 215, 170)
        case .pink: RGB(251, 207, 232)
        case .indigo: RGB(199, 210, 254)
        }
    }

    private typealias RGB = (red: CGFloat, green: CGFloat, blue: CGFloat)

    private static func adaptiveUIColor(
        light: RGB,
        dark: RGB) -> UIColor
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

enum OpenClawBrand {
    /// Accent fills stay dark enough for white content; foreground accents adapt
    /// separately so small labels retain 4.5:1 contrast on dark surfaces and tinted pills.
    static var uiAccent: UIColor {
        AppAccentColorPreference.current.uiColor
    }

    static var uiAccentForeground: UIColor {
        AppAccentColorPreference.current.foregroundUIColor
    }

    static var uiAccentHotForeground: UIColor {
        AppAccentColorPreference.current.hotForegroundUIColor
    }

    static let uiOK = adaptiveUIColor(light: (19, 122, 62), dark: (48, 209, 88))
    static let uiWarn = adaptiveUIColor(light: (154, 87, 0), dark: (255, 214, 10))
    static let uiDanger = adaptiveUIColor(light: (185, 28, 28), dark: (252, 165, 165))
    static let uiInfo = adaptiveUIColor(light: (0, 91, 196), dark: (100, 168, 255))

    static var accent: Color {
        AppAccentColorPreference.current.color
    }

    static var accentForeground: Color {
        Color(uiColor: uiAccentForeground)
    }

    static var accentHot: Color {
        AppAccentColorPreference.current.hotColor
    }

    static var accentHotForeground: Color {
        Color(uiColor: uiAccentHotForeground)
    }

    static let danger = Color(uiColor: Self.uiDanger)
    static let ok = Color(uiColor: Self.uiOK)
    static let warn = Color(uiColor: Self.uiWarn)
    static let info = Color(uiColor: Self.uiInfo)
    static let graphite = Color(uiColor: adaptiveUIColor(light: (246, 247, 249), dark: (11, 12, 17)))
    static let graphiteElevated = Color(uiColor: adaptiveUIColor(light: (255, 255, 255), dark: (19, 21, 28)))

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

    @MainActor
    static func applyWindowChrome(appearance: AppAppearancePreference) {
        let style = appearance.userInterfaceStyle
        let tint = Self.uiAccent
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .forEach { window in
                window.overrideUserInterfaceStyle = style
                window.tintColor = tint
            }
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
        tint(OpenClawBrand.accent)
            .background {
                OpenClawBrand.sheetBackground
                    .ignoresSafeArea()
            }
    }
}
