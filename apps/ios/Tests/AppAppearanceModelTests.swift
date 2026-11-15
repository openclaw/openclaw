import Foundation
import OpenClawChatUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct AppAppearanceModelTests {
    @Test func scopedOfflineEditsSurviveRestartWithoutCrossingProfiles() throws {
        let name = "AppAppearanceModelTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let owner = AppAppearanceModel(userDefaults: defaults)
        let alice = AppAppearanceModel.Scope(gatewayID: "gateway-a", profileID: "alice")
        let bob = AppAppearanceModel.Scope(gatewayID: "gateway-a", profileID: "bob")
        owner.prepareSync(scope: alice)
        owner.selectFamily(.tide)
        owner.connectionChanged(gatewayID: "gateway-a", connected: false)
        owner.select(.light)
        let queued = owner.pending
        #expect(queued.count == 2)
        #expect(queued.allSatisfy { $0.scope == alice })

        let restored = AppAppearanceModel(userDefaults: defaults)
        #expect(restored.family == .tide)
        #expect(restored.preference == .light)
        #expect(restored.pending == queued)
        restored.prepareSync(scope: bob)
        restored.applyRemote([.family: "rose", .mode: "dark", .accent: nil], revisions: [:], protected: [])
        #expect(restored.family == .rose)
        #expect(restored.pending == queued)
        restored.prepareSync(scope: nil)
        restored.selectFamily(.beacon)
        restored.complete(queued[0])
        #expect(restored.family == .beacon)
        #expect(restored.pending.count == 1)
    }

    @Test func staleReadsAndAcknowledgementsDoNotReplaceNewerChoices() throws {
        let name = "AppAppearanceModelTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let owner = AppAppearanceModel(userDefaults: defaults)
        owner.prepareSync(scope: .init(gatewayID: "gateway-a", profileID: "alice"))
        let before = owner.revisions
        owner.selectAccent("#ffc233")
        let first = try #require(owner.pending.first)
        owner.selectAccent("#5a9bef")
        owner.complete(first)
        owner.applyRemote([.family: "tide", .mode: "dark", .accent: "#ffffff"], revisions: before, protected: [])
        #expect(owner.accentHex == "#5a9bef")
        #expect(owner.pending.count == 1)
        #expect(owner.pending.first?.value == "#5a9bef")
    }

    @Test func nativeColorsAndPrimaryInkUseTheResolvedAndroidPalette() throws {
        let light = AppThemeFamily.tide.palette(dark: false, accentHex: nil)
        let dark = AppThemeFamily.tide.palette(dark: true, accentHex: nil)
        let appearance = OpenClawNativeAppearance(themeID: "tide", light: light, dark: dark)
        for (style, canvas, primary) in [
            (UIUserInterfaceStyle.light, UInt32(0xFFF7F9FB), UInt32(0xFF1F6F8F)),
            (.dark, 0xFF10151B, 0xFF5AB6D8),
        ] {
            let traits = UITraitCollection { mutable in
                mutable.userInterfaceStyle = style
                mutable[OpenClawNativeAppearanceTrait.self] = appearance
            }
            #expect(OpenClawBrand.uiVoid.resolvedColor(with: traits) == OpenClawNativePalette.uiColor(canvas))
            #expect(OpenClawBrand.uiAccentFill.resolvedColor(with: traits) == OpenClawNativePalette.uiColor(primary))
        }
        let override = AppThemeFamily.tide.palette(dark: true, accentHex: "#ffc233")
        #expect(override.colors[.primary] == 0xFFFFC233)
        #expect(override.colors[.primaryText] == 0xFF000000)
        #expect(override.colors[.userMessageSurface] == 0xFF2D2A1E)
        #expect(override.webVariables["--primary"] == "#ffc233ff")
    }
}
