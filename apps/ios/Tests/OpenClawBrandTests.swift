import Testing
import UIKit
@testable import OpenClaw

struct OpenClawBrandTests {
    @Test func `appearance preference details match selection`() {
        #expect(AppAppearancePreference.system.detail == "Matches the system appearance.")
        #expect(AppAppearancePreference.light.detail == "Always uses light appearance.")
        #expect(AppAppearancePreference.dark.detail == "Always uses dark appearance.")
    }

    @Test func `semantic colors meet text contrast in both appearances`() {
        let colors = [OpenClawBrand.uiOK, OpenClawBrand.uiWarn, OpenClawBrand.uiInfo]
        let backgrounds = [UIColor.systemBackground, UIColor.secondarySystemBackground]

        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            for color in colors {
                for background in backgrounds {
                    #expect(Self.contrastRatio(color, background, traits: traits) >= 4.5)
                }
            }
        }
    }

    private static func contrastRatio(
        _ foreground: UIColor,
        _ background: UIColor,
        traits: UITraitCollection) -> CGFloat
    {
        let foregroundLuminance = Self.relativeLuminance(foreground, traits: traits)
        let backgroundLuminance = Self.relativeLuminance(background, traits: traits)
        let lighter = max(foregroundLuminance, backgroundLuminance)
        let darker = min(foregroundLuminance, backgroundLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private static func relativeLuminance(_ color: UIColor, traits: UITraitCollection) -> CGFloat {
        let resolved = color.resolvedColor(with: traits)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return 0 }

        func linearize(_ component: CGFloat) -> CGFloat {
            component <= 0.04045
                ? component / 12.92
                : pow((component + 0.055) / 1.055, 2.4)
        }

        return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue)
    }
}
