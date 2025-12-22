import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum ClawdisChatTheme {
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
                    Color(nsColor: .windowBackgroundColor).opacity(0.85),
                    Color.black.opacity(0.92)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            RadialGradient(
                colors: [
                    Color(nsColor: .systemOrange).opacity(0.18),
                    .clear
                ],
                center: .topLeading,
                startRadius: 40,
                endRadius: 320)
            RadialGradient(
                colors: [
                    Color(nsColor: .systemTeal).opacity(0.16),
                    .clear
                ],
                center: .topTrailing,
                startRadius: 40,
                endRadius: 280)
            Color.black.opacity(0.12)
        }
        #else
        Color(uiColor: .systemBackground)
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
        #if os(macOS)
        Color(nsColor: .systemBlue)
        #else
        Color(uiColor: .systemBlue)
        #endif
    }

    static var assistantBubble: Color {
        #if os(macOS)
        let base = NSColor.controlBackgroundColor
        let blended = base.blended(withFraction: 0.18, of: .white) ?? base
        return Color(nsColor: blended).opacity(0.88)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var onboardingAssistantBubble: Color {
        #if os(macOS)
        let base = NSColor.controlBackgroundColor
        let blended = base.blended(withFraction: 0.22, of: .white) ?? base
        return Color(nsColor: blended)
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
}

enum ClawdisPlatformImageFactory {
    static func image(_ image: ClawdisPlatformImage) -> Image {
        #if os(macOS)
        Image(nsImage: image)
        #else
        Image(uiImage: image)
        #endif
    }
}
