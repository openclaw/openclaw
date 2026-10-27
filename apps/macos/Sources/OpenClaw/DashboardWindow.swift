import AppKit
import Foundation
import OSLog

let dashboardWindowLogger = Logger(subsystem: "ai.openclaw", category: "DashboardWindow")

enum DashboardWindowLayout {
    static let windowSize = NSSize(width: 1240, height: 860)
    static let windowMinSize = NSSize(width: 922, height: 620)
    static let windowFrameAutosaveName = "OpenClawDashboardWindow"
}

/// Raw values are window event names the Control UI handles. `newSession`
/// reuses the shipped pre-web-chrome event; `commandPalette` gets a dedicated
/// toggle event because the legacy `native-open-search` contract is open-only.
enum DashboardNativeCommand: String {
    case newSession = "openclaw:native-new-session"
    case commandPalette = "openclaw:native-toggle-search"

    /// Older gateway bundles lack the toggle listener; dispatch degrades to the
    /// open-only legacy event when the primary event goes unhandled.
    var legacyFallbackEventName: String? {
        switch self {
        case .newSession: nil
        case .commandPalette: "openclaw:native-open-search"
        }
    }

    var supersedesPendingNavigation: Bool {
        self == .newSession
    }
}

struct DashboardNativeNavigation: Equatable {
    let path: String
    var search: String?
    let fallbackURL: URL
}

enum DashboardTargetlessNavigationAction: Equatable {
    case allow
    case openExternal
    case cancel
}

enum DashboardNewWindowAction: Equatable {
    case openTab(URL)
    case openExternal(URL)
    case ignore
}

enum DashboardWindowAuth: Equatable {
    case unauthenticated
    // Token/password track config changes for document replacement. Only the
    // separate accepted legacyCredentials map may reach a released UI; current
    // UI uses native signing and never browser fallback. nil means not ready.
    case nativeDevice(gatewayUrl: String, token: String?, password: String?, legacyCredentials: [String: String]? = nil)
    case browserIdentity(gatewayUrl: String)

    var gatewayUrl: String? {
        switch self {
        case .unauthenticated: nil
        case let .browserIdentity(gatewayUrl): gatewayUrl
        case let .nativeDevice(gatewayUrl, _, _, _): gatewayUrl
        }
    }

    var token: String? {
        switch self {
        case let .nativeDevice(_, token, _, _): token
        case .unauthenticated, .browserIdentity: nil
        }
    }

    var password: String? {
        switch self {
        case let .nativeDevice(_, _, password, _): password
        case .unauthenticated, .browserIdentity: nil
        }
    }

    var hasAcceptedNativeBinding: Bool {
        if case let .nativeDevice(_, _, _, credentials) = self { return credentials != nil }
        return false
    }

    var usesBrowserIdentity: Bool {
        if case .browserIdentity = self { return true }
        return false
    }

    var usesNativeDevice: Bool {
        if case .nativeDevice = self { return true }
        return false
    }

    var hasCredential: Bool {
        self.token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ||
            self.password?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
}
