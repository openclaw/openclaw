import XCTest
import SwiftUI
@testable import OpenClawKit

#if os(macOS)
import AppKit
#endif

final class ColorHexSupportContrastTests: XCTestCase {
    #if os(macOS)
    func testTealGetsBlackText() {
        // Actual teal from ColorPalette.colors (light mode)
        let teal = Color(red: 0.188, green: 0.69, blue: 0.78)
        let textColor = ColorHexSupport.contrastingTextColor(for: teal)

        // Teal (luminance ~0.358) should get black text (contrast 8.16) over white (contrast 2.57)
        XCTAssertEqual(textColor, Color.black, "Teal should get black text for better WCAG contrast ratio")
    }

    func testMidRangeGreen() {
        let green = Color(red: 76/255.0, green: 175/255.0, blue: 80/255.0)
        let textColor = ColorHexSupport.contrastingTextColor(for: green)

        // This green (luminance ~0.328) should get black text (contrast 7.56) over white (contrast 2.78)
        XCTAssertEqual(textColor, Color.black, "Mid-range green should get black text for better contrast")
    }

    func testMidRangeOrange() {
        let orange = Color(red: 255/255.0, green: 152/255.0, blue: 0/255.0)
        let textColor = ColorHexSupport.contrastingTextColor(for: orange)

        // This orange has luminance around 0.5, should get black text
        XCTAssertEqual(textColor, Color.black, "Mid-range orange should get black text")
    }

    func testMidRangePurple() {
        let purple = Color(red: 156/255.0, green: 39/255.0, blue: 176/255.0)
        let textColor = ColorHexSupport.contrastingTextColor(for: purple)

        // This purple has low luminance, white text should have better contrast
        // Need to verify actual contrast ratios for this color
        let nsColor = NSColor(purple)
        guard let rgbColor = nsColor.usingColorSpace(.deviceRGB) else {
            XCTFail("Failed to convert purple to RGB color space")
            return
        }

        func luminance(for color: NSColor) -> CGFloat {
            func linearize(_ component: CGFloat) -> CGFloat {
                component <= 0.04045 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
            }
            let rLinear = linearize(color.redComponent)
            let gLinear = linearize(color.greenComponent)
            let bLinear = linearize(color.blueComponent)
            return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear
        }

        func contrastRatio(lum1: CGFloat, lum2: CGFloat) -> CGFloat {
            let lighter = max(lum1, lum2)
            let darker = min(lum1, lum2)
            return (lighter + 0.05) / (darker + 0.05)
        }

        let purpleLum = luminance(for: rgbColor)
        let whiteContrast = contrastRatio(lum1: purpleLum, lum2: 1.0)
        let blackContrast = contrastRatio(lum1: purpleLum, lum2: 0.0)

        if whiteContrast > blackContrast {
            XCTAssertEqual(textColor, Color.white, "Purple should get white text (white contrast \(whiteContrast) > black \(blackContrast))")
        } else {
            XCTAssertEqual(textColor, Color.black, "Purple should get black text (black contrast \(blackContrast) > white \(whiteContrast))")
        }
    }

    func testVeryLightColorGetsBlackText() {
        let lightGray = Color(red: 0.9, green: 0.9, blue: 0.9)
        let textColor = ColorHexSupport.contrastingTextColor(for: lightGray)

        XCTAssertEqual(textColor, Color.black, "Very light gray should get black text")
    }

    func testVeryDarkColorGetsWhiteText() {
        let darkGray = Color(red: 0.1, green: 0.1, blue: 0.1)
        let textColor = ColorHexSupport.contrastingTextColor(for: darkGray)

        XCTAssertEqual(textColor, Color.white, "Very dark gray should get white text")
    }

    func testWhiteGetsBlackText() {
        let textColor = ColorHexSupport.contrastingTextColor(for: .white)
        XCTAssertEqual(textColor, Color.black, "White background should get black text")
    }

    func testBlackGetsWhiteText() {
        let textColor = ColorHexSupport.contrastingTextColor(for: .black)
        XCTAssertEqual(textColor, Color.white, "Black background should get white text")
    }
    #endif
}
