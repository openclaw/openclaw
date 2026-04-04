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
            LinearGradient(
                colors: [
                    Color(red: 0.97, green: 0.94, blue: 0.89),
                    Color(red: 0.96, green: 0.96, blue: 0.94),
                    Color(red: 0.90, green: 0.94, blue: 0.99),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            Ellipse()
                .fill(Color(red: 0.98, green: 0.82, blue: 0.60).opacity(0.26))
                .frame(width: 520, height: 360)
                .blur(radius: 96)
                .offset(x: -220, y: -190)
            Ellipse()
                .fill(Color(red: 0.72, green: 0.86, blue: 0.97).opacity(0.24))
                .frame(width: 620, height: 320)
                .blur(radius: 110)
                .offset(x: 180, y: 260)
            Rectangle()
                .fill(.ultraThinMaterial)
                .opacity(0.38)
        }
        #else
        Color(uiColor: .systemBackground)
        #endif
    }

    @ViewBuilder
    static var workspaceBackground: some View {
        #if os(macOS)
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.97, green: 0.95, blue: 0.91),
                    Color(red: 0.95, green: 0.96, blue: 0.95),
                    Color(red: 0.90, green: 0.94, blue: 0.98),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            Ellipse()
                .fill(Color(red: 0.99, green: 0.82, blue: 0.60).opacity(0.26))
                .frame(width: 520, height: 360)
                .blur(radius: 94)
                .offset(x: -280, y: -180)
            Ellipse()
                .fill(Color(red: 0.86, green: 0.92, blue: 0.98).opacity(0.32))
                .frame(width: 520, height: 320)
                .blur(radius: 92)
                .offset(x: 260, y: 210)
            Ellipse()
                .fill(Color.white.opacity(0.42))
                .frame(width: 420, height: 240)
                .blur(radius: 84)
                .offset(y: -120)
            Rectangle()
                .fill(.ultraThinMaterial)
                .opacity(0.30)
        }
        #else
        Color(uiColor: .systemGroupedBackground)
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
        AnyShapeStyle(Color(uiColor: .secondarySystemBackground).opacity(0.9))
        #endif
    }

    static var userBubble: Color {
        Color(red: 127 / 255.0, green: 184 / 255.0, blue: 212 / 255.0)
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

    static var userText: Color { .white }

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
        AnyShapeStyle(Color(uiColor: .systemBackground))
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
        Color.white.opacity(0.12)
    }

    static var divider: Color {
        Color.secondary.opacity(0.2)
    }

    static var workspacePanel: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(
            LinearGradient(
                colors: [
                    Color.white.opacity(0.72),
                    Color(red: 0.90, green: 0.94, blue: 0.98).opacity(0.44),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing))
        #else
        AnyShapeStyle(Color(uiColor: .secondarySystemBackground))
        #endif
    }

    static var workspacePanelSecondary: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(
            LinearGradient(
                colors: [
                    Color.white.opacity(0.66),
                    Color(red: 0.95, green: 0.96, blue: 0.97).opacity(0.46),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing))
        #else
        AnyShapeStyle(Color(uiColor: .tertiarySystemBackground))
        #endif
    }

    static var workspacePanelBorder: Color {
        Color.white.opacity(0.52)
    }

    static var workspaceDivider: Color {
        Color.white.opacity(0.30)
    }

    static var workspaceAssistantBubble: Color {
        #if os(macOS)
        Color.white.opacity(0.76)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var workspaceUserBubble: Color {
        Color(red: 0.18, green: 0.42, blue: 0.78)
    }

    static var workspaceSoftFill: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(
            LinearGradient(
                colors: [
                    Color.white.opacity(0.62),
                    Color(red: 0.84, green: 0.90, blue: 0.97).opacity(0.22),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing))
        #else
        AnyShapeStyle(Color(uiColor: .tertiarySystemBackground))
        #endif
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
