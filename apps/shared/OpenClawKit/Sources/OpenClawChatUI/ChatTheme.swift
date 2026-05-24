import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

#if os(macOS)
extension NSAppearance {
    fileprivate var isDarkAqua: Bool {
        self.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }
}
#endif

enum OpenClawChatTheme {
    #if !os(macOS)
    private enum IOSPalette {
        static let lightCanvasTop = UIColor(red: 246 / 255.0, green: 247 / 255.0, blue: 249 / 255.0, alpha: 1)
        static let lightCanvasMiddle = UIColor(red: 250 / 255.0, green: 251 / 255.0, blue: 252 / 255.0, alpha: 1)
        static let lightCanvasBottom = UIColor.white
        static let lightAccent = UIColor(red: 220 / 255.0, green: 38 / 255.0, blue: 38 / 255.0, alpha: 1)
        static let lightAccentHot = UIColor(red: 239 / 255.0, green: 68 / 255.0, blue: 68 / 255.0, alpha: 1)
        static let darkCanvasTop = UIColor(red: 4 / 255.0, green: 8 / 255.0, blue: 8 / 255.0, alpha: 1)
        static let darkCanvasMiddle = UIColor(red: 16 / 255.0, green: 19 / 255.0, blue: 20 / 255.0, alpha: 1)
        static let darkAccent = UIColor(red: 198 / 255.0, green: 49 / 255.0, blue: 42 / 255.0, alpha: 1)
        static let darkAccentHot = UIColor(red: 239 / 255.0, green: 62 / 255.0, blue: 82 / 255.0, alpha: 1)
    }

    private static func adaptiveColor(
        light: UIColor,
        dark: UIColor) -> Color
    {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }
    #endif

    #if os(macOS)
    static func resolvedAssistantBubbleColor(for appearance: NSAppearance) -> NSColor {
        // NSColor semantic colors don't reliably resolve for arbitrary NSAppearance in SwiftPM.
        // Use explicit light/dark values so the bubble updates when the system appearance flips.
        appearance.isDarkAqua
            ? NSColor(calibratedWhite: 0.18, alpha: 0.88)
            : NSColor(calibratedWhite: 0.94, alpha: 0.92)
    }

    static func resolvedOnboardingAssistantBubbleColor(for appearance: NSAppearance) -> NSColor {
        appearance.isDarkAqua
            ? NSColor(calibratedWhite: 0.20, alpha: 0.94)
            : NSColor(calibratedWhite: 0.97, alpha: 0.98)
    }

    static let assistantBubbleDynamicNSColor = NSColor(
        name: NSColor.Name("OpenClawChatTheme.assistantBubble"),
        dynamicProvider: resolvedAssistantBubbleColor(for:))

    static let onboardingAssistantBubbleDynamicNSColor = NSColor(
        name: NSColor.Name("OpenClawChatTheme.onboardingAssistantBubble"),
        dynamicProvider: resolvedOnboardingAssistantBubbleColor(for:))
    #endif

    static var surface: Color {
        #if os(macOS)
        Color(nsColor: .windowBackgroundColor)
        #else
        Color(uiColor: .systemBackground)
        #endif
    }

    @ViewBuilder
    static var background: some View {
        #if os(macOS)
        ZStack {
            Rectangle()
                .fill(.ultraThinMaterial)
            LinearGradient(
                colors: [
                    Color.white.opacity(0.12),
                    Color(nsColor: .windowBackgroundColor).opacity(0.35),
                    Color.black.opacity(0.35),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            RadialGradient(
                colors: [
                    Color(nsColor: .systemOrange).opacity(0.14),
                    .clear,
                ],
                center: .topLeading,
                startRadius: 40,
                endRadius: 320)
            RadialGradient(
                colors: [
                    Color(nsColor: .systemTeal).opacity(0.12),
                    .clear,
                ],
                center: .topTrailing,
                startRadius: 40,
                endRadius: 280)
            Color.black.opacity(0.08)
        }
        #else
        ZStack {
            LinearGradient(
                colors: [
                    self.adaptiveColor(
                        light: IOSPalette.lightCanvasTop,
                        dark: IOSPalette.darkCanvasTop),
                    self.adaptiveColor(
                        light: IOSPalette.lightCanvasMiddle,
                        dark: IOSPalette.darkCanvasMiddle),
                    self.adaptiveColor(
                        light: IOSPalette.lightCanvasBottom,
                        dark: .systemBackground),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            RadialGradient(
                colors: [
                    self.adaptiveColor(
                        light: IOSPalette.lightAccentHot,
                        dark: IOSPalette.darkAccentHot)
                        .opacity(0.08),
                    .clear,
                ],
                center: .topTrailing,
                startRadius: 24,
                endRadius: 360)
        }
        #endif
    }

    static var card: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var subtleCard: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(.ultraThinMaterial)
        #else
        AnyShapeStyle(Color(uiColor: .tertiarySystemBackground))
        #endif
    }

    static var userBubble: Color {
        #if os(macOS)
        Color(red: 127 / 255.0, green: 184 / 255.0, blue: 212 / 255.0)
        #else
        self.adaptiveColor(
            light: IOSPalette.lightAccent,
            dark: IOSPalette.darkAccent)
        #endif
    }

    static var assistantBubble: Color {
        #if os(macOS)
        Color(nsColor: self.assistantBubbleDynamicNSColor)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var onboardingAssistantBubble: Color {
        #if os(macOS)
        Color(nsColor: self.onboardingAssistantBubbleDynamicNSColor)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var onboardingAssistantBorder: Color {
        #if os(macOS)
        Color.white.opacity(0.12)
        #else
        Color.white.opacity(0.12)
        #endif
    }

    static var userText: Color {
        .white
    }

    static var assistantText: Color {
        #if os(macOS)
        Color(nsColor: .labelColor)
        #else
        Color(uiColor: .label)
        #endif
    }

    static var composerBackground: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(.ultraThinMaterial)
        #else
        AnyShapeStyle(.regularMaterial)
        #endif
    }

    static var composerField: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(.thinMaterial)
        #else
        AnyShapeStyle(Color(uiColor: .secondarySystemBackground))
        #endif
    }

    static var composerBorder: Color {
        #if os(macOS)
        Color.white.opacity(0.12)
        #else
        self.adaptiveColor(light: .separator, dark: UIColor.white.withAlphaComponent(0.14))
        #endif
    }

    static var divider: Color {
        Color.secondary.opacity(0.2)
    }
}

enum OpenClawPlatformImageFactory {
    static func image(_ image: OpenClawPlatformImage) -> Image {
        #if os(macOS)
        Image(nsImage: image)
        #else
        Image(uiImage: image)
        #endif
    }
}
