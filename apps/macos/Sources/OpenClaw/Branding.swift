import Foundation

enum Branding {
    static let appName = "VeriClaw 爪印"
    static let shortAppName = "VeriClaw"
    static let executableName = "VeriClaw"
    static let bundleIdentifier = "ai.vericlaw.mac"
    static let legacyBundleIdentifier = "ai.openclaw.mac"
    static let urlScheme = "vericlaw"
    static var appBundleName: String { "\(self.appName).app" }
    static var controlWindowTitle: String { "\(self.appName) Control Center" }
    static var chatWindowTitle: String { "\(self.appName) Manual Chat" }
    static var canvasWindowTitle: String { "\(self.appName) Verification Workspace" }
}
