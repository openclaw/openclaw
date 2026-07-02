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
    static let activationCanvas = Color(uiColor: adaptiveUIColor(light: (255, 255, 255), dark: (18, 14, 15)))
    static let activationSurface = Color(uiColor: adaptiveUIColor(light: (255, 253, 252), dark: (33, 29, 30)))
    static let activationInsetSurface = Color(uiColor: adaptiveUIColor(light: (246, 241, 238), dark: (44, 37, 38)))
    static let activationNeutralSurface = Color(uiColor: adaptiveUIColor(light: (242, 242, 247), dark: (34, 34, 37)))
    static let activationNeutralInsetSurface = Color(uiColor: adaptiveUIColor(
        light: (247, 247, 249),
        dark: (42, 42, 45)))
    static let activationNeutralStroke = Color(uiColor: adaptiveUIColor(
        light: (0, 0, 0),
        dark: (255, 255, 255)).withAlphaComponent(0.08))
    static let activationNeutralDivider = Color(uiColor: adaptiveUIColor(
        light: (0, 0, 0),
        dark: (255, 255, 255)).withAlphaComponent(0.09))
    static let activationPrimaryAction = Color(uiColor: adaptiveUIColor(light: (209, 54, 51), dark: (238, 82, 76)))
    static let activationPrimaryActionText = Color.white
    static let activationHairline = Color(uiColor: adaptiveUIColor(
        light: (136, 44, 40),
        dark: (255, 210, 205)).withAlphaComponent(0.13))
    static let activationGlow = Color(uiColor: adaptiveUIColor(light: (228, 78, 67), dark: (255, 111, 96)))
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

    static var activationCanvasGradient: LinearGradient {
        LinearGradient(
            colors: [
                activationCanvas,
                activationCanvas,
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }

    static var activationSurfaceGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color.white.opacity(0.16),
                activationSurface,
                activationSurface,
                activationGlow.opacity(0.06),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }

    static var activationInsetGradient: LinearGradient {
        LinearGradient(
            colors: [
                activationInsetSurface.opacity(0.94),
                activationInsetSurface,
                activationSurface.opacity(0.36),
            ],
            startPoint: .top,
            endPoint: .bottom)
    }

    static var activationNeutralGradient: LinearGradient {
        LinearGradient(
            colors: [
                activationNeutralInsetSurface,
                activationNeutralSurface,
            ],
            startPoint: .top,
            endPoint: .bottom)
    }

    static var activationPrimaryGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 1.0, green: 0.42, blue: 0.34),
                activationGlow,
                activationPrimaryAction,
                Color(red: 0.66, green: 0.12, blue: 0.12),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }

    static var activationDisabledGradient: LinearGradient {
        LinearGradient(
            colors: [
                activationNeutralInsetSurface,
                activationNeutralSurface.opacity(0.92),
            ],
            startPoint: .top,
            endPoint: .bottom)
    }

    static var activationSurfaceStroke: LinearGradient {
        LinearGradient(
            colors: [
                Color.white.opacity(0.72),
                activationHairline,
                Color.black.opacity(0.08),
            ],
            startPoint: .top,
            endPoint: .bottom)
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

    func openClawCraftSurface(cornerRadius: CGFloat = 24, shadow: Bool = true) -> some View {
        self.modifier(OpenClawCraftSurfaceModifier(cornerRadius: cornerRadius, shadow: shadow))
    }
}

private struct OpenClawCraftSurfaceModifier: ViewModifier {
    let cornerRadius: CGFloat
    let shadow: Bool

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .fill(OpenClawBrand.activationSurface)
                    .shadow(
                        color: self.shadow ? Color.black.opacity(0.07) : .clear,
                        radius: 16,
                        x: 0,
                        y: 8)
            }
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .stroke(Color.white.opacity(0.36), lineWidth: 0.5)
                    .blendMode(.plusLighter)
            }
            .overlay {
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .stroke(OpenClawBrand.activationHairline, lineWidth: 0.5)
            }
    }
}

struct OpenClawPrimaryActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var height: CGFloat = 54
    var cornerRadius: CGFloat = 18

    private var resolvedCornerRadius: CGFloat {
        self.height / 2
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(self.isEnabled ? OpenClawBrand.activationPrimaryActionText : Color.secondary)
            .tint(self.isEnabled ? OpenClawBrand.activationPrimaryActionText : Color.secondary)
            .frame(maxWidth: .infinity)
            .frame(height: self.height)
            .background {
                RoundedRectangle(cornerRadius: self.resolvedCornerRadius, style: .continuous)
                    .fill(self.isEnabled ? Self.primaryFill : OpenClawBrand.activationDisabledGradient)
                    .shadow(
                        color: self.isEnabled ? OpenClawBrand.activationPrimaryAction.opacity(0.08) : .clear,
                        radius: 1,
                        x: 0,
                        y: 1)
                    .shadow(
                        color: self.isEnabled ? OpenClawBrand.activationPrimaryAction.opacity(0.08) : .clear,
                        radius: 2,
                        x: 0,
                        y: 2)
            }
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: self.resolvedCornerRadius, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(self.isEnabled ? 0.14 : 0.06),
                                Color.white.opacity(0),
                            ],
                            startPoint: .top,
                            endPoint: .center))
                    .frame(height: self.height * 0.48)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .bottom) {
                RoundedRectangle(cornerRadius: self.resolvedCornerRadius, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0),
                                Color.white.opacity(self.isEnabled ? 0.08 : 0.03),
                            ],
                            startPoint: .top,
                            endPoint: .bottom))
                    .frame(height: self.height * 0.34)
                    .allowsHitTesting(false)
            }
            .overlay {
                RoundedRectangle(cornerRadius: self.resolvedCornerRadius, style: .continuous)
                    .stroke(
                        self.isEnabled
                            ? OpenClawBrand.activationPrimaryAction.opacity(0.72)
                            : OpenClawBrand.activationNeutralStroke,
                        lineWidth: 0.75)
            }
            .scaleEffect(configuration.isPressed && self.isEnabled ? 0.98 : 1)
            .animation(.smooth(duration: 0.14), value: configuration.isPressed)
    }

    private static var primaryFill: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.93, green: 0.27, blue: 0.25),
                Color(red: 0.91, green: 0.25, blue: 0.24),
            ],
            startPoint: .top,
            endPoint: .bottom)
    }
}

struct OpenClawSecondaryActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var height: CGFloat = 50
    var cornerRadius: CGFloat = 18

    private var resolvedCornerRadius: CGFloat {
        self.height / 2
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(self.isEnabled ? OpenClawBrand.activationPrimaryAction : .secondary)
            .frame(maxWidth: .infinity)
            .frame(height: self.height)
            .background {
                RoundedRectangle(cornerRadius: self.resolvedCornerRadius, style: .continuous)
                    .fill(Self.secondaryFill)
                    .shadow(
                        color: self.isEnabled ? Color.black.opacity(0.035) : .clear,
                        radius: 1,
                        x: 0,
                        y: 1)
                    .shadow(
                        color: self.isEnabled ? Color.black.opacity(0.035) : .clear,
                        radius: 2,
                        x: 0,
                        y: 2)
            }
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: self.resolvedCornerRadius, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.42),
                                Color.white.opacity(0),
                            ],
                            startPoint: .top,
                            endPoint: .center))
                    .frame(height: self.height * 0.48)
                    .allowsHitTesting(false)
            }
            .overlay {
                RoundedRectangle(cornerRadius: self.resolvedCornerRadius, style: .continuous)
                    .stroke(OpenClawBrand.activationHairline, lineWidth: 0.75)
            }
            .scaleEffect(configuration.isPressed && self.isEnabled ? 0.98 : 1)
            .animation(.smooth(duration: 0.14), value: configuration.isPressed)
    }

    private static var secondaryFill: LinearGradient {
        LinearGradient(
            colors: [
                OpenClawBrand.activationSurface,
                OpenClawBrand.activationSurface.opacity(0.96),
            ],
            startPoint: .top,
            endPoint: .bottom)
    }
}

struct OpenClawTertiaryActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var height: CGFloat = 44

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .foregroundStyle(
                self.isEnabled
                    ? OpenClawBrand.activationPrimaryAction.opacity(0.78)
                    : Color.secondary)
            .frame(maxWidth: .infinity)
            .frame(height: self.height)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed && self.isEnabled ? 0.66 : 1)
            .scaleEffect(configuration.isPressed && self.isEnabled ? 0.985 : 1)
            .animation(.smooth(duration: 0.14), value: configuration.isPressed)
    }
}

struct OpenClawCloseButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var minWidth: CGFloat = 36
    var height: CGFloat = 36

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(
                self.isEnabled
                    ? OpenClawBrand.activationPrimaryAction
                    : Color.secondary)
            .fixedSize(horizontal: true, vertical: false)
            .frame(minWidth: self.minWidth)
            .frame(height: self.height)
            .padding(.horizontal, 7)
            .background {
                Capsule(style: .continuous)
                    .fill(OpenClawBrand.activationNeutralGradient)
                    .shadow(
                        color: self.isEnabled ? Color.black.opacity(0.045) : .clear,
                        radius: 1,
                        x: 0,
                        y: 1)
                    .shadow(
                        color: self.isEnabled ? Color.black.opacity(0.03) : .clear,
                        radius: 4,
                        x: 0,
                        y: 2)
            }
            .overlay(alignment: .top) {
                Capsule(style: .continuous)
                    .stroke(Color.white.opacity(0.55), lineWidth: 0.5)
                    .blendMode(.plusLighter)
            }
            .overlay {
                Capsule(style: .continuous)
                    .stroke(OpenClawBrand.activationNeutralStroke, lineWidth: 0.6)
            }
            .contentShape(Capsule(style: .continuous))
            .opacity(configuration.isPressed && self.isEnabled ? 0.66 : 1)
            .scaleEffect(configuration.isPressed && self.isEnabled ? 0.98 : 1)
            .animation(.smooth(duration: 0.14), value: configuration.isPressed)
    }
}
