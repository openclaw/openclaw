#if os(iOS)
import SwiftUI
import UIKit

/// Semantic colors supplied by the native host, not a theme renderer.
public struct OpenClawNativePalette: Equatable, Sendable {
    public enum Token: String, CaseIterable, Sendable {
        case canvas, surface, raised, pressed, accent, accentSoft, accentBorder, userMessageSurface
        case border, borderStrong, text, muted, subtle, primary, primaryText, secondary, codeBackground
    }

    public var colors: [Token: UInt32]

    public init(colors: [Token: UInt32]) {
        self.colors = colors
    }

    public static func uiColor(_ argb: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((argb >> 16) & 0xFF) / 255,
            green: CGFloat((argb >> 8) & 0xFF) / 255,
            blue: CGFloat(argb & 0xFF) / 255,
            alpha: CGFloat(argb >> 24) / 255)
    }

    public static func color(_ token: Token, fallback: UIColor) -> UIColor {
        UIColor { @Sendable traits in
            guard let appearance = traits[OpenClawNativeAppearanceTrait.self],
                  let argb = (traits.userInterfaceStyle == .dark ? appearance.dark : appearance.light).colors[token]
            else { return fallback.resolvedColor(with: traits) }
            return Self.uiColor(argb)
        }
    }
}

public struct OpenClawNativeAppearance: Equatable, Sendable {
    public let themeID: String
    public let light: OpenClawNativePalette
    public let dark: OpenClawNativePalette

    public init(themeID: String, light: OpenClawNativePalette, dark: OpenClawNativePalette) {
        self.themeID = themeID
        self.light = light
        self.dark = dark
    }
}

public struct OpenClawNativeAppearanceTrait: UITraitDefinition {
    public static let defaultValue: OpenClawNativeAppearance? = nil
    public static let affectsColorAppearance = true
}

private struct NativeAppearanceKey: UITraitBridgedEnvironmentKey {
    static let defaultValue: OpenClawNativeAppearance? = nil

    static func read(from traits: UITraitCollection) -> OpenClawNativeAppearance? {
        traits[OpenClawNativeAppearanceTrait.self]
    }

    static func write(to traits: inout any UIMutableTraits, value: OpenClawNativeAppearance?) {
        traits[OpenClawNativeAppearanceTrait.self] = value
    }
}

extension EnvironmentValues {
    public var openClawNativeAppearance: OpenClawNativeAppearance? {
        get { self[NativeAppearanceKey.self] }
        set { self[NativeAppearanceKey.self] = newValue }
    }
}
#endif
