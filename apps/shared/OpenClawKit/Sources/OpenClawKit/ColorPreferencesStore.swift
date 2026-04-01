import Foundation
import Observation
import SwiftUI

public enum ColorPalette {
    public struct PaletteColor: Sendable {
        public let light: Color
        public let dark: Color

        public init(light: Color, dark: Color) {
            self.light = light
            self.dark = dark
        }
    }

    public static let colors: [PaletteColor] = [
        // Blue
        PaletteColor(
            light: Color(red: 0.0, green: 0.478, blue: 1.0),
            dark: Color(red: 0.039, green: 0.518, blue: 1.0)
        ),
        // Purple
        PaletteColor(
            light: Color(red: 0.686, green: 0.322, blue: 0.871),
            dark: Color(red: 0.749, green: 0.353, blue: 0.949)
        ),
        // Pink
        PaletteColor(
            light: Color(red: 1.0, green: 0.176, blue: 0.333),
            dark: Color(red: 1.0, green: 0.216, blue: 0.373)
        ),
        // Red
        PaletteColor(
            light: Color(red: 1.0, green: 0.231, blue: 0.188),
            dark: Color(red: 1.0, green: 0.271, blue: 0.227)
        ),
        // Orange
        PaletteColor(
            light: Color(red: 1.0, green: 0.584, blue: 0.0),
            dark: Color(red: 1.0, green: 0.624, blue: 0.039)
        ),
        // Yellow
        PaletteColor(
            light: Color(red: 1.0, green: 0.8, blue: 0.0),
            dark: Color(red: 1.0, green: 0.839, blue: 0.039)
        ),
        // Green
        PaletteColor(
            light: Color(red: 0.204, green: 0.78, blue: 0.349),
            dark: Color(red: 0.196, green: 0.843, blue: 0.294)
        ),
        // Teal
        PaletteColor(
            light: Color(red: 0.188, green: 0.69, blue: 0.78),
            dark: Color(red: 0.251, green: 0.784, blue: 0.878)
        ),
        // Indigo
        PaletteColor(
            light: Color(red: 0.345, green: 0.337, blue: 0.839),
            dark: Color(red: 0.373, green: 0.361, blue: 0.902)
        ),
        // Brown
        PaletteColor(
            light: Color(red: 0.635, green: 0.518, blue: 0.369),
            dark: Color(red: 0.675, green: 0.557, blue: 0.408)
        ),
    ]
}

@Observable
public final class ColorPreferencesStore {
    nonisolated(unsafe) public static let shared = ColorPreferencesStore()

    private static let useAccentColorKey = "ColorPreferences.useAccentColor"
    private static let selectedPaletteIndexKey = "ColorPreferences.selectedPaletteIndex"
    private static let customColorHexKey = "ColorPreferences.customColorHex"

    public var useAccentColor: Bool {
        didSet {
            UserDefaults.standard.set(useAccentColor, forKey: Self.useAccentColorKey)
        }
    }

    public var selectedPaletteIndex: Int? {
        didSet {
            if let index = selectedPaletteIndex {
                UserDefaults.standard.set(index, forKey: Self.selectedPaletteIndexKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.selectedPaletteIndexKey)
            }
        }
    }

    public var customColorHex: String? {
        didSet {
            if let hex = customColorHex {
                UserDefaults.standard.set(hex, forKey: Self.customColorHexKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.customColorHexKey)
            }
        }
    }

    private init() {
        self.useAccentColor = UserDefaults.standard.object(forKey: Self.useAccentColorKey) as? Bool ?? true

        if let savedIndex = UserDefaults.standard.object(forKey: Self.selectedPaletteIndexKey) as? Int {
            self.selectedPaletteIndex = savedIndex
        } else {
            self.selectedPaletteIndex = nil
        }

        self.customColorHex = UserDefaults.standard.string(forKey: Self.customColorHexKey)
    }

    public var resolvedColor: Color {
        if useAccentColor {
            return Color.accentColor
        }

        if let hex = customColorHex, let color = ColorHexSupport.color(fromHex: hex) {
            return color
        }

        if let index = selectedPaletteIndex,
           index >= 0,
           index < ColorPalette.colors.count
        {
            let paletteColor = ColorPalette.colors[index]
            #if os(macOS)
            let isDark: Bool
            if Thread.isMainThread {
                isDark = MainActor.assumeIsolated {
                    NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                }
            } else {
                isDark = false
            }
            return isDark ? paletteColor.dark : paletteColor.light
            #else
            return paletteColor.light
            #endif
        }

        return Color.accentColor
    }
}
