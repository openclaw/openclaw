import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

@MainActor
@Observable
final class AppAppearanceModel {
    enum Key: String, Codable, CaseIterable { case family = "ui.theme", mode = "ui.themeMode", accent = "ui.accent" }
    struct Scope: Codable, Equatable { let gatewayID: String; let profileID: String }
    struct Pending: Codable, Equatable {
        let scope: Scope
        let key: Key
        let value: String?
        let id: UUID
    }

    private(set) var preference: AppAppearancePreference
    private(set) var family: AppThemeFamily
    private(set) var accentHex: String?
    var gatewayAccentHex: String?
    private(set) var editScope: Scope?
    private(set) var pending: [Pending]
    private var localOnly: Set<Key>
    private(set) var revisions: [Key: UInt64] = [:]
    private let defaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.defaults = userDefaults
        let savedMode = userDefaults.string(forKey: AppAppearancePreference.storageKey)
            .flatMap(AppAppearancePreference.init(rawValue:))
        self.preference = AppAppearancePreference.launchArgumentPreference ?? savedMode ?? .system
        self.family = userDefaults.string(forKey: "appearance.themeFamily").flatMap(AppThemeFamily.init(rawValue:)) ?? .claw
        self.accentHex = GatewayUserPreferences.normalizedAccentHex(userDefaults.string(forKey: "appearance.accentHex"))
        self.pending = userDefaults.data(forKey: "appearance.pendingPreferences")
            .flatMap { try? PropertyListDecoder().decode([Pending].self, from: $0) } ?? []
        self.localOnly = Set((userDefaults.stringArray(forKey: "appearance.localOnlyKeys") ?? []).compactMap(Key.init(rawValue:)))
        // Preserve the device-only appearance chosen before profile synchronization existed.
        if !userDefaults.bool(forKey: "appearance.syncInitialized") {
            if savedMode != nil { self.localOnly.insert(.mode) }
            userDefaults.set(true, forKey: "appearance.syncInitialized")
            self.persistSyncState()
        }
        if AppAppearancePreference.launchArgumentPreference != nil {
            self.select(self.preference)
        }
    }

    var appearance: OpenClawNativeAppearance {
        OpenClawNativeAppearance(themeID: self.family.rawValue, light: self.palette(dark: false), dark: self.palette(dark: true))
    }

    func palette(dark: Bool) -> OpenClawNativePalette {
        self.family.palette(dark: dark, accentHex: self.accentHex ?? self.gatewayAccentHex)
    }

    func select(_ preference: AppAppearancePreference, userDefaults: UserDefaults? = nil) {
        self.edit(.mode, value: preference.rawValue, defaults: userDefaults)
    }

    func selectFamily(_ family: AppThemeFamily) { self.edit(.family, value: family.rawValue) }

    func selectAccent(_ hex: String?) {
        self.edit(.accent, value: GatewayUserPreferences.normalizedAccentHex(hex))
    }

    private func edit(_ key: Key, value: String?, defaults: UserDefaults? = nil) {
        if let scope = self.editScope {
            self.pending.removeAll { $0.scope == scope && $0.key == key }
            self.pending.append(Pending(scope: scope, key: key, value: value, id: UUID()))
            self.localOnly.remove(key)
        } else {
            // Profile-less/read-only edits stay local; they never retire another profile's queue.
            self.localOnly.insert(key)
        }
        self.revisions[key, default: 0] &+= 1
        self.apply(key, value: value, defaults: defaults ?? self.defaults)
        self.persistSyncState()
    }

    func prepareSync(scope: Scope?) { self.editScope = scope }

    func connectionChanged(gatewayID: String?, connected: Bool) {
        if connected || self.editScope?.gatewayID != gatewayID { self.editScope = nil }
        if self.editScope?.gatewayID != gatewayID { self.gatewayAccentHex = nil }
    }

    func complete(_ entry: Pending) {
        guard self.pending.contains(entry) else { return }
        if !self.localOnly.contains(entry.key), self.editScope == entry.scope {
            self.apply(entry.key, value: entry.value, defaults: self.defaults)
        }
        self.pending.removeAll { $0.id == entry.id }
        self.persistSyncState()
    }

    func applyRemote(_ values: [Key: String?], revisions: [Key: UInt64], protected: Set<Key>) {
        for key in Key.allCases where !self.localOnly.contains(key) && !protected.contains(key) &&
            self.revisions[key, default: 0] == revisions[key, default: 0]
        {
            self.apply(key, value: values[key] ?? nil, defaults: self.defaults)
        }
    }

    private func apply(_ key: Key, value: String?, defaults: UserDefaults) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            switch key {
            case .mode:
                self.preference = value.flatMap(AppAppearancePreference.init(rawValue:)) ?? .system
                defaults.set(self.preference.rawValue, forKey: AppAppearancePreference.storageKey)
            case .family:
                self.family = value.flatMap(AppThemeFamily.init(rawValue:)) ?? .claw
                defaults.set(self.family.rawValue, forKey: "appearance.themeFamily")
            case .accent:
                self.accentHex = GatewayUserPreferences.normalizedAccentHex(value)
                defaults.set(self.accentHex, forKey: "appearance.accentHex")
            }
        }
    }

    private func persistSyncState() {
        self.defaults.set(try? PropertyListEncoder().encode(self.pending), forKey: "appearance.pendingPreferences")
        self.defaults.set(self.localOnly.map(\.rawValue).sorted(), forKey: "appearance.localOnlyKeys")
    }
}
