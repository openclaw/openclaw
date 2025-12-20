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

    static var card: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var subtleCard: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor).opacity(0.55)
        #else
        Color(uiColor: .secondarySystemBackground).opacity(0.9)
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
        Color(nsColor: .controlBackgroundColor)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var onboardingAssistantBubble: Color {
        #if os(macOS)
        Color(nsColor: .controlBackgroundColor).opacity(0.92)
        #else
        Color(uiColor: .secondarySystemBackground)
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

    static var composerBackground: Color {
        #if os(macOS)
        Color(nsColor: .windowBackgroundColor)
        #else
        Color(uiColor: .systemBackground)
        #endif
    }

    static var composerField: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var composerBorder: Color {
        Color.secondary.opacity(0.2)
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
