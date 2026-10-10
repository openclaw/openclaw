import Observation
import OpenClawChatUI
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

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

@MainActor
@Observable
final class AppAppearanceModel {
    private(set) var preference: AppAppearancePreference

    init(userDefaults: UserDefaults = .standard) {
        let storedPreference = userDefaults.string(forKey: AppAppearancePreference.storageKey)
            .flatMap(AppAppearancePreference.init(rawValue:))
        self.preference = AppAppearancePreference.launchArgumentPreference ?? storedPreference ?? .system
        if AppAppearancePreference.launchArgumentPreference != nil {
            userDefaults.set(self.preference.rawValue, forKey: AppAppearancePreference.storageKey)
        }
    }

    func select(_ preference: AppAppearancePreference, userDefaults: UserDefaults = .standard) {
        guard self.preference != preference else { return }
        userDefaults.set(preference.rawValue, forKey: AppAppearancePreference.storageKey)
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            self.preference = preference
        }
    }
}

enum OpenClawBrand {
    // Carapace semantic palette: these tokens are shared by voice surfaces that
    // need the web system's quieter ink/paper hierarchy in native SwiftUI.
    static let carapaceElevated = Color(red: 32 / 255.0, green: 32 / 255.0, blue: 36 / 255.0)
    static let carapaceCoral = Color(red: 245 / 255.0, green: 101 / 255.0, blue: 74 / 255.0)
    static let carapaceSea = Color(red: 79 / 255.0, green: 200 / 255.0, blue: 174 / 255.0)
    // Accent fills stay dark enough for white content; foreground accents adapt
    // separately so small labels retain 4.5:1 contrast on dark surfaces and tinted pills.
    static let uiAccentFill = adaptiveUIColor(light: (183, 56, 51), dark: (198, 62, 56))
    static let uiAccent = adaptiveUIColor(light: (183, 56, 51), dark: (255, 107, 102))
    static let uiAccentHot = adaptiveUIColor(light: (204, 75, 69), dark: (232, 92, 86))
    static let uiAccentHotForeground = adaptiveUIColor(light: (166, 55, 50), dark: (255, 123, 115))
    static let uiVoid = adaptiveUIColor(light: (246, 247, 249), dark: (11, 12, 17))
    static let uiObsidian = adaptiveUIColor(light: (255, 255, 255), dark: (19, 21, 28))
    static let uiTextSecondary = adaptiveUIColor(light: (90, 94, 110), dark: (168, 170, 191))
    static let uiOK = adaptiveUIColor(light: (19, 122, 62), dark: (48, 209, 88))
    static let uiWarn = adaptiveUIColor(light: (154, 87, 0), dark: (255, 214, 10))
    static let uiDanger = adaptiveUIColor(light: (185, 28, 28), dark: (252, 165, 165))
    static let uiInfo = adaptiveUIColor(light: (0, 91, 196), dark: (100, 168, 255))
    // Carapace status foreground tokens. Keep these separate from the broader
    // app feedback palette so compact state indicators match the web system.
    static let uiStatusSuccess = adaptiveUIColor(light: (22, 163, 74), dark: (34, 197, 94))
    static let uiStatusWarning = adaptiveUIColor(light: (217, 119, 6), dark: (251, 191, 36))
    static let uiStatusError = adaptiveUIColor(light: (220, 38, 38), dark: (239, 68, 68))

    static let accent = Color(uiColor: Self.uiAccent)
    static let accentFill = Color(uiColor: Self.uiAccentFill)
    static let accentHot = Color(uiColor: Self.uiAccentHot)
    static let accentHotForeground = Color(uiColor: Self.uiAccentHotForeground)
    static let void = Color(uiColor: Self.uiVoid)
    static let obsidian = Color(uiColor: Self.uiObsidian)
    static let textSecondary = Color(uiColor: Self.uiTextSecondary)
    static let danger = Color(uiColor: Self.uiDanger)
    static let ok = Color(uiColor: Self.uiOK)
    static let warn = Color(uiColor: Self.uiWarn)
    static let info = Color(uiColor: Self.uiInfo)
    static let statusSuccess = Color(uiColor: Self.uiStatusSuccess)
    static let statusWarning = Color(uiColor: Self.uiStatusWarning)
    static let statusError = Color(uiColor: Self.uiStatusError)
    // Keep provider colors aligned with the Control UI brand tokens.
    static let providerOpenAI = Color(red: 16 / 255.0, green: 163 / 255.0, blue: 127 / 255.0)
    static let providerAnthropic = Color(red: 217 / 255.0, green: 119 / 255.0, blue: 87 / 255.0)
    static let providerGoogle = Color(red: 66 / 255.0, green: 133 / 255.0, blue: 244 / 255.0)
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

    static var sheetBackground: LinearGradient {
        LinearGradient(
            colors: [
                void,
                obsidian.opacity(0.96),
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

extension TalkWaveformPalette {
    /// iOS app branding for shared voice contours. This lives with the palette
    /// owner so removing a presentation surface cannot remove the app theme.
    static let openClawBrand = TalkWaveformPalette(
        active: [
            OpenClawBrand.carapaceCoral,
            OpenClawBrand.carapaceSea,
            OpenClawBrand.accent,
        ],
        inactive: [
            Color(uiColor: .systemGray2),
            Color(uiColor: .systemGray3),
            Color(uiColor: .systemGray4),
        ])
}

struct OpenClawActivationGlyph: View {
    let size: CGFloat
    var mood: OpenClawMascotMood = .idle
    /// Opt-in tap Easter eggs; leave off when the glyph sits inside a control.
    var interactive = false

    var body: some View {
        OpenClawMascotView(floats: false, mood: self.mood, interactive: self.interactive)
            .frame(width: self.size, height: self.size)
            .shadow(
                color: OpenClawBrand.activationGlow.opacity(0.18),
                radius: self.size * 0.12,
                x: 0,
                y: self.size * 0.05)
            .accessibilityHidden(true)
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

    func openClawCraftSurface(cornerRadius: CGFloat = 24) -> some View {
        self
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(OpenClawBrand.activationSurface)
                    .shadow(
                        color: Color.black.opacity(0.07),
                        radius: 16,
                        x: 0,
                        y: 8)
            }
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(Color.white.opacity(0.36), lineWidth: 0.5)
                    .blendMode(.plusLighter)
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(OpenClawBrand.activationHairline, lineWidth: 0.5)
            }
    }
}

/// Capsule surface shared by the branded button styles. iOS 26 uses system
/// Liquid Glass (prominent is tinted); earlier systems get a flat adaptive fill.
/// No gradients, sheens, or shadows: they turn into a muddy halo on dark surfaces.
enum OpenClawButtonSurfaceKind {
    case prominent
    case secondary
}

private struct OpenClawButtonSurfaceModifier: ViewModifier {
    let kind: OpenClawButtonSurfaceKind
    let isEnabled: Bool
    let isPressed: Bool

    private var isFilled: Bool {
        self.kind == .prominent && self.isEnabled
    }

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(self.glass, in: .capsule)
        } else {
            content
                .background(Capsule(style: .continuous).fill(self.fallbackFill))
                .overlay {
                    if !self.isFilled {
                        Capsule(style: .continuous).strokeBorder(Color(uiColor: .separator), lineWidth: 0.75)
                    }
                }
                .opacity(self.isPressed && self.isEnabled ? 0.82 : 1)
                .animation(.smooth(duration: 0.14), value: self.isPressed)
        }
    }

    @available(iOS 26.0, *)
    private var glass: Glass {
        self.isFilled ? .regular.tint(OpenClawBrand.accentFill).interactive() : .regular.interactive(self.isEnabled)
    }

    private var fallbackFill: Color {
        self.isFilled ? OpenClawBrand.accentFill : OpenClawBrand.activationNeutralSurface
    }
}

extension View {
    func openClawButtonSurface(
        _ kind: OpenClawButtonSurfaceKind,
        isEnabled: Bool,
        isPressed: Bool) -> some View
    {
        self.modifier(OpenClawButtonSurfaceModifier(kind: kind, isEnabled: isEnabled, isPressed: isPressed))
    }

    /// System prominent button filled with the accent. The app tint is the readable
    /// foreground accent, so prominent fills must opt into the darker fill accent.
    func openClawProminentButton() -> some View {
        self.buttonStyle(.borderedProminent).tint(OpenClawBrand.accentFill)
    }
}

struct OpenClawPrimaryActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var height: CGFloat = 54

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(OpenClawType.subheadSemiBold)
            .foregroundStyle(self.isEnabled ? OpenClawBrand.activationPrimaryActionText : Color.secondary)
            // Spinners inside the label must not inherit the red app tint over the red fill.
            .tint(self.isEnabled ? OpenClawBrand.activationPrimaryActionText : Color.secondary)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.8)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: self.height)
            .openClawButtonSurface(.prominent, isEnabled: self.isEnabled, isPressed: configuration.isPressed)
            .contentShape(Capsule(style: .continuous))
    }
}

struct OpenClawSecondaryActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var height: CGFloat = 50

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(OpenClawType.subheadSemiBold)
            .foregroundStyle(self.isEnabled ? OpenClawBrand.accent : Color.secondary)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.8)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: self.height)
            .openClawButtonSurface(.secondary, isEnabled: self.isEnabled, isPressed: configuration.isPressed)
            .contentShape(Capsule(style: .continuous))
    }
}

struct OpenClawCloseButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var minWidth: CGFloat = 36
    var height: CGFloat = 36

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(OpenClawType.subheadSemiBold)
            .foregroundStyle(self.isEnabled ? OpenClawBrand.accent : Color.secondary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(minWidth: self.minWidth, minHeight: self.height)
            .padding(.horizontal, 7)
            .openClawButtonSurface(.secondary, isEnabled: self.isEnabled, isPressed: configuration.isPressed)
            // Visual stays 36pt; the vertical padding brings the hit area to 44pt.
            .padding(.vertical, 4)
            .contentShape(Rectangle())
    }
}
