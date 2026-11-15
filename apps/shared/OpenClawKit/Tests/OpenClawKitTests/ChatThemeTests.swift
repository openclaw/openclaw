import Foundation
import SwiftUI
import Testing
@testable import OpenClawChatUI

#if os(macOS)
import AppKit
#endif

#if os(macOS)
private func luminance(_ color: NSColor) throws -> CGFloat {
    let rgb = try #require(color.usingColorSpace(.deviceRGB))
    return 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
}
#endif

struct ChatThemeTests {
    @Test(arguments: [ColorScheme.light, .dark], [ColorSchemeContrast.standard, .increased])
    func `desktop reading colors preserve enhanced contrast`(
        appearance: ColorScheme,
        contrast: ColorSchemeContrast)
    {
        var environment = EnvironmentValues()
        environment.colorScheme = appearance
        let text = OpenClawChatTheme.desktopText(in: appearance, contrast: contrast)
        let canvas = OpenClawChatTheme.desktopCanvas(in: appearance)
        #expect(Self.contrast(text, canvas, in: environment) >= 7)
        if contrast == .increased {
            let standardText = OpenClawChatTheme.desktopText(in: appearance, contrast: .standard)
            #expect(Self.contrast(text, canvas, in: environment) > Self.contrast(standardText, canvas, in: environment))
        }

        for red in [0.0, 1.0] {
            for green in [0.0, 1.0] {
                for blue in [0.0, 1.0] {
                    let accent = Color(.sRGB, red: red, green: green, blue: blue)
                    let bubble = OpenClawChatTheme.desktopUserBubble(in: appearance, accent: accent)
                    #expect(Self.contrast(text, bubble, in: environment) >= 7)
                }
            }
        }
    }

    private static func contrast(
        _ foreground: Color,
        _ background: Color,
        in environment: EnvironmentValues) -> Double
    {
        func luminance(_ color: Color) -> Double {
            let resolved = color.resolve(in: environment)
            func linear(_ component: Float) -> Double {
                let value = Double(component)
                return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(resolved.red)
                + 0.7152 * linear(resolved.green)
                + 0.0722 * linear(resolved.blue)
        }
        let foreground = luminance(foreground)
        let background = luminance(background)
        return (max(foreground, background) + 0.05) / (min(foreground, background) + 0.05)
    }

    @Test(arguments: ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"])
    func `session colors normalize and adapt`(name: String) throws {
        let color = try #require(OpenClawSessionColor(name: " \(name.uppercased()) "))
        #expect(color.rawValue == name)
        #expect(OpenClawChatTheme.relativeLuminance(of: color.tint(in: .dark)) >
            OpenClawChatTheme.relativeLuminance(of: color.tint(in: .light)))
    }

    @Test(arguments: [nil, "", "gray", "grey", "default", "reset", "none", "#ff0000"] as [String?])
    func `unknown session color has no decoration`(name: String?) {
        #expect(OpenClawSessionColor(name: name) == nil)
    }

    @Test func `assistant bubble resolves for light and dark`() throws {
        #if os(macOS)
        let lightAppearance = try #require(NSAppearance(named: .aqua))
        let darkAppearance = try #require(NSAppearance(named: .darkAqua))

        let lightResolved = OpenClawChatTheme.resolvedAssistantBubbleColor(for: lightAppearance)
        let darkResolved = OpenClawChatTheme.resolvedAssistantBubbleColor(for: darkAppearance)
        #expect(try luminance(lightResolved) > luminance(darkResolved))
        #else
        #expect(Bool(true))
        #endif
    }
}
