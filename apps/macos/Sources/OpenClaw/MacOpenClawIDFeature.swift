import AppKit
import AuthenticationServices
import OpenClawKit

/// OpenClaw ID entry points appear only in builds that package the native transport
/// (`OPENCLAW_IROH_NATIVE=1`); other builds hide the feature entirely.
enum MacOpenClawIDFeature {
    static var isEnabled: Bool {
        OpenClawIDNodeNativeEndpoint.isPackaged
    }

    /// The staging "OpenClaw for Mac" native client; its redirect is `ai.openclaw.mac:/oauth/callback`.
    static let stagingClientID = "DulSrXtaYtPaLEnzEyHGuAHpVNWmaNbf"

    static func configuration(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> OpenClawIDConfiguration? {
        .current(stagingClientID: Self.stagingClientID, callbackScheme: "ai.openclaw.mac", info: info)
    }

    @MainActor
    static func signIn(_ configuration: OpenClawIDConfiguration) -> OpenClawIDSignIn {
        OpenClawIDSignIn(configuration: configuration) {
            NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        }
    }
}
