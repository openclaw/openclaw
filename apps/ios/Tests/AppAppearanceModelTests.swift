import Foundation
import OpenClawChatUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct AppAppearanceModelTests {
    @Test(arguments: ["system", "light", "dark"])
    func `legacy device mode survives conflicting remote and second initialization`(_ savedMode: String) throws {
        let name = "AppAppearanceModelTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(savedMode, forKey: AppAppearancePreference.storageKey)
        let scope = AppAppearanceModel.Scope(gatewayID: "gateway-a", profileID: "alice")
        let owner = AppAppearanceModel(userDefaults: defaults)
        owner.prepareSync(scope: scope)
        let conflict = savedMode == "light" ? "dark" : "light"
        owner.applyRemote(
            [.family: "tide", .mode: conflict, .accent: "#ffc233"],
            revisions: [:],
            protected: [])
        #expect(owner.preference.rawValue == savedMode)
        #expect(owner.family == .tide)
        #expect(owner.accentHex == "#ffc233")
        let restored = AppAppearanceModel(userDefaults: defaults)
        restored.prepareSync(scope: scope)
        restored.applyRemote([.mode: conflict], revisions: [:], protected: [])
        #expect(restored.preference.rawValue == savedMode)
        try restored.select(#require(AppAppearancePreference(rawValue: conflict)))
        #expect(restored.preference.rawValue == conflict)
        #expect(restored.pending.contains { $0.scope == scope && $0.key == .mode && $0.value == conflict })
    }

    @Test func `scoped offline edits survive restart without crossing profiles`() throws {
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

    @Test func `stale reads and acknowledgements do not replace newer choices`() throws {
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

    @Test func `native colors and primary ink use the resolved android palette`() {
        let light = AppThemeFamily.tide.palette(dark: false, accentHex: nil)
        let dark = AppThemeFamily.tide.palette(dark: true, accentHex: nil)
        let appearance = OpenClawNativeAppearance(themeID: "tide", light: light, dark: dark)
        for (style, canvas, primary) in [
            (UIUserInterfaceStyle.light, UInt32(0xFFF7_F9FB), UInt32(0xFF1F_6F8F)),
            (.dark, 0xFF10_151B, 0xFF5A_B6D8),
        ] {
            let traits = UITraitCollection { mutable in
                mutable.userInterfaceStyle = style
                mutable[OpenClawNativeAppearanceTrait.self] = appearance
            }
            #expect(OpenClawBrand.uiVoid.resolvedColor(with: traits) == OpenClawNativePalette.uiColor(canvas))
            #expect(OpenClawBrand.uiAccentFill.resolvedColor(with: traits) == OpenClawNativePalette.uiColor(primary))
        }
        let override = AppThemeFamily.tide.palette(dark: true, accentHex: "#ffc233")
        #expect(override.colors[.primary] == 0xFFFF_C233)
        #expect(override.colors[.primaryText] == 0xFF00_0000)
        #expect(override.colors[.userMessageSurface] == 0xFF2D_2A1E)
        #expect(override.webVariables["--primary"] == "#ffc233ff")
    }
}
