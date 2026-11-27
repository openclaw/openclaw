import Foundation
import OpenClawKit

@MainActor
enum DeviceSettingsConsent: Equatable {
    case cookieSync
    case cookieDomains([String])
    case cookieProfile(String)
    case computerControl
    case desktopSharing
    case unattendedDesktop
    case peekabooBridge
    case camera
    case activityReporting
    case voiceWake
    case locationWhileUsing
    case locationAlways
    case preciseLocation

    static func required(
        for key: DeviceSettingKey,
        value: DeviceSettingValue,
        cookieSyncEnabled: Bool,
        cookieDomains: [String],
        cookieProfile: String,
        locationMode: DeviceSettingsLocationMode) -> Self?
    {
        switch (key, value) {
        case (.cookieSyncEnabled, .boolean(true)): .cookieSync
        case (.computerControlEnabled, .boolean(true)): .computerControl
        case (.desktopSharingEnabled, .boolean(true)): .desktopSharing
        case (.unattendedDesktopEnabled, .boolean(true)): .unattendedDesktop
        case (.peekabooBridgeEnabled, .boolean(true)): .peekabooBridge
        case (.cameraEnabled, .boolean(true)): .camera
        case (.activeComputerPresenceEnabled, .boolean(true)): .activityReporting
        case (.wakeEnabled, .boolean(true)): .voiceWake
        case (.locationPrecise, .boolean(true)): .preciseLocation
        case let (.locationMode, .string(mode)):
            switch (locationMode, DeviceSettingsLocationMode(rawValue: mode)) {
            case (.off, .whileUsing): .locationWhileUsing
            case (.off, .always), (.whileUsing, .always): .locationAlways
            default: nil
            }
        case let (.cookieSyncDomains, .strings(domains)):
            Self.addedCookieDomains(domains, current: cookieDomains)
        case let (.cookieSyncTargetProfile, .string(profile)):
            Self.changedCookieProfile(profile, current: cookieProfile, enabled: cookieSyncEnabled)
        default: nil
        }
    }

    private static func addedCookieDomains(_ domains: [String], current: [String]) -> Self? {
        let existing = Set(CookieSyncManager.normalizedDomains(current).map { $0.lowercased() })
        let added = CookieSyncManager.normalizedDomains(domains).filter { !existing.contains($0.lowercased()) }
        return added.isEmpty ? nil : .cookieDomains(added)
    }

    private static func changedCookieProfile(_ profile: String, current: String, enabled: Bool) -> Self? {
        let profile = profile.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "imported"
        return enabled && profile != current ? .cookieProfile(profile) : nil
    }

    var message: String {
        switch self {
        case .cookieSync:
            String(localized: "Allow browser cookie sync from this Mac?")
        case .cookieDomains:
            String(localized: "Allow cookie sync for additional domains?")
        case .cookieProfile:
            String(localized: "Change the browser cookie sync destination?")
        case .computerControl:
            String(localized: "Allow the Gateway to control this Mac?")
        case .desktopSharing:
            String(localized: "Allow desktop sharing from this Mac?")
        case .unattendedDesktop:
            String(localized: "Keep this computer awake?")
        case .peekabooBridge:
            String(localized: "Enable the Peekaboo bridge on this Mac?")
        case .camera:
            String(localized: "Allow the Gateway to use this Mac's camera?")
        case .activityReporting:
            String(localized: "Enable system-wide presence detection?")
        case .voiceWake:
            String(localized: "Enable continuous microphone listening?")
        case .locationWhileUsing:
            String(localized: "Allow location access while using OpenClaw?")
        case .locationAlways:
            String(localized: "Allow location access at any time?")
        case .preciseLocation:
            String(localized: "Allow precise location access?")
        }
    }

    var detail: String {
        switch self {
        case .unattendedDesktop:
            String(
                localized: """
                While connected and hosting sessions, OpenClaw keeps the unlocked desktop awake between jobs. \
                Manual lock and logout still stop Computer work. Disabling this setting restores normal idle behavior.
                """)
        case .cookieSync:
            String(
                localized: """
                Browser cookies for the configured domains will be sent to your remote Gateway. \
                These cookies can grant access to your signed-in accounts.
                """)
        case let .cookieDomains(domains):
            String(
                format: String(
                    localized: """
                    Cookies for these additional domains can be sent to your remote Gateway when sync is enabled: %@. \
                    These cookies can grant access to your signed-in accounts.
                    """),
                domains.joined(separator: ", "))
        case let .cookieProfile(profile):
            String(
                format: String(
                    localized: """
                    Cookie sync is enabled. Browser cookies will be sent to the remote browser profile “%@”. \
                    These cookies can grant access to your signed-in accounts.
                    """),
                profile)
        case .computerControl:
            String(
                localized: """
                The Gateway can capture your screen and interact with apps on this Mac, \
                including clicking and typing, subject to macOS permissions.
                """)
        case .desktopSharing:
            String(
                localized: """
                Your paired Gateway can view and control this Mac through its existing Screen Sharing service. \
                You may need to approve the updated node capabilities in Devices. \
                macOS Screen Sharing and agent Computer Control remain separate settings.
                """)
        case .peekabooBridge:
            String(
                localized: """
                Local automation clients can use the Peekaboo bridge to capture your screen and control apps \
                on this Mac using OpenClaw's macOS permissions.
                """)
        case .camera:
            String(
                localized: """
                The Gateway can request photos and video from this Mac's camera, subject to macOS permission.
                """)
        case .voiceWake:
            String(localized: "Voice Wake will continuously listen for wake phrases through this Mac's microphone.")
        case .activityReporting:
            String(
                localized: """
                OpenClaw activity already identifies this Mac without extra permissions. \
                This also shares idle duration from activity in other apps and requires Accessibility. \
                It never sends keys, pointer positions, app names, or window titles.
                """)
        case .locationWhileUsing:
            String(localized: "The Gateway can request this Mac's location while OpenClaw is in use.")
        case .locationAlways:
            String(localized: "The Gateway can request this Mac's location even when OpenClaw is not in use.")
        case .preciseLocation:
            String(localized: "The Gateway can request this Mac's precise location when location access is enabled.")
        }
    }
}
