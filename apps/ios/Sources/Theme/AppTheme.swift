import SwiftUI

enum AppTheme: String, CaseIterable {
    case system
    case light
    case dark

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    func isDark(systemScheme: ColorScheme) -> Bool {
        switch self {
        case .system: systemScheme == .dark
        case .light: false
        case .dark: true
        }
    }
}
