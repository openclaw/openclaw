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

    var detail: String {
        switch self {
        case .system: "Matches the system appearance."
        case .light: "Always uses light appearance."
        case .dark: "Always uses dark appearance."
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
    static let uiAccent = adaptiveUIColor(light: (183, 56, 51), dark: (198, 62, 56))
    static let uiOK = adaptiveUIColor(light: (19, 122, 62), dark: (48, 209, 88))
    static let uiWarn = adaptiveUIColor(light: (154, 87, 0), dark: (255, 214, 10))
    static let uiInfo = adaptiveUIColor(light: (0, 91, 196), dark: (100, 168, 255))

    static let accent = Color(uiColor: Self.uiAccent)
    static let accentHot = Color(uiColor: adaptiveUIColor(light: (204, 75, 69), dark: (232, 92, 86)))
    static let danger = Color(uiColor: adaptiveUIColor(light: (185, 28, 28), dark: (252, 165, 165)))
    static let ok = Color(uiColor: Self.uiOK)
    static let warn = Color(uiColor: Self.uiWarn)
    static let info = Color(uiColor: Self.uiInfo)
    static let graphite = Color(uiColor: adaptiveUIColor(light: (246, 247, 249), dark: (20, 22, 24)))
    static let graphiteElevated = Color(uiColor: adaptiveUIColor(light: (255, 255, 255), dark: (34, 36, 39)))

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
