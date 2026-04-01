import SwiftUI

#if os(macOS)
import AppKit
#endif

public enum ColorHexSupport {
    public static func color(fromHex hex: String) -> Color? {
        let hexString = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)

        guard hexString.count == 6 else {
            return nil
        }

        var rgbValue: UInt64 = 0
        guard Scanner(string: hexString).scanHexInt64(&rgbValue) else {
            return nil
        }

        let red = Double((rgbValue & 0xFF0000) >> 16) / 255.0
        let green = Double((rgbValue & 0x00FF00) >> 8) / 255.0
        let blue = Double(rgbValue & 0x0000FF) / 255.0

        return Color(red: red, green: green, blue: blue)
    }

    public static func hex(from color: Color) -> String? {
        #if os(macOS)
        guard let nsColor = NSColor(color).usingColorSpace(.deviceRGB) else {
            return nil
        }
        let red = Int(nsColor.redComponent * 255)
        let green = Int(nsColor.greenComponent * 255)
        let blue = Int(nsColor.blueComponent * 255)
        return String(format: "#%02X%02X%02X", red, green, blue)
        #else
        let uiColor = UIColor(color)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0

        guard uiColor.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return nil
        }

        let redInt = Int(red * 255)
        let greenInt = Int(green * 255)
        let blueInt = Int(blue * 255)
        return String(format: "#%02X%02X%02X", redInt, greenInt, blueInt)
        #endif
    }

    #if os(macOS)
    public static func contrastingTextColor(for backgroundColor: Color) -> Color {
        let nsColor = NSColor(backgroundColor)
        guard let rgbColor = nsColor.usingColorSpace(.deviceRGB) else {
            return .white
        }

        // Calculate relative luminance using WCAG formula with gamma linearization
        func luminance(for color: NSColor) -> CGFloat {
            func linearize(_ component: CGFloat) -> CGFloat {
                component <= 0.04045 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
            }
            let rLinear = linearize(color.redComponent)
            let gLinear = linearize(color.greenComponent)
            let bLinear = linearize(color.blueComponent)
            return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear
        }

        // Calculate WCAG contrast ratio between two colors
        func contrastRatio(lum1: CGFloat, lum2: CGFloat) -> CGFloat {
            let lighter = max(lum1, lum2)
            let darker = min(lum1, lum2)
            return (lighter + 0.05) / (darker + 0.05)
        }

        let bgLuminance = luminance(for: rgbColor)
        let whiteLuminance: CGFloat = 1.0
        let blackLuminance: CGFloat = 0.0

        let whiteContrast = contrastRatio(lum1: bgLuminance, lum2: whiteLuminance)
        let blackContrast = contrastRatio(lum1: bgLuminance, lum2: blackLuminance)

        return whiteContrast > blackContrast ? Color.white : Color.black
    }
    #endif
}
