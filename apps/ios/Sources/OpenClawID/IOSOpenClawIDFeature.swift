import AuthenticationServices
import Foundation
import OpenClawKit
import OSLog
import UIKit

/// OpenClaw ID appears only in builds that package the native transport (`OPENCLAW_IROH_NATIVE=1`);
/// other builds hide every entry point.
enum IOSOpenClawIDFeature {
    static let logger = Logger(subsystem: "ai.openclaw", category: "openclaw-id")

    static var isEnabled: Bool {
        OpenClawIDNodeNativeEndpoint.isPackaged
    }

    /// The staging "OpenClaw for iOS" native client; its redirect is `ai.openclaw.ios:/oauth/callback`.
    static let stagingClientID = "GowfnkQNWyllNYcatbyHsFEQayOmAyyg"

    static func configuration(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> OpenClawIDConfiguration? {
        .current(stagingClientID: self.stagingClientID, callbackScheme: "ai.openclaw.ios", info: info)
    }

    /// Device, pending member request and Discovery session of this iPhone or iPad.
    @MainActor
    static let records = OpenClawIDDeviceRecords(
        defaults: .standard,
        keyPrefix: "openclaw.ios.openClawID",
        sessionService: "ai.openclaw.ios.openclaw-id-session")

    /// The native trust store of this app's OpenClaw ID enrollments.
    static var databaseURL: URL {
        let directory = URL.applicationSupportDirectory.appendingPathComponent("OpenClawID", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("openclaw-id.sqlite")
    }

    /// Sign-in-first setup for this device. It joins without a node: chat and the dashboard only.
    @MainActor
    static func setupService() -> OpenClawIDAccountSetupService {
        let configuration = Self.configuration()
        let signIn = configuration.map { configuration in
            OpenClawIDSignIn(configuration: configuration) {
                UIApplication.shared.connectedScenes
                    .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                    .first ?? ASPresentationAnchor()
            }
        }
        let records = Self.records
        return OpenClawIDAccountSetupService(
            configuration: configuration,
            databaseURL: Self.databaseURL,
            nodeInvitations: nil,
            environment: .init(
                signIn: { freshLogin in
                    guard let signIn else { throw OpenClawIDSignInError.refused }
                    return try await signIn.signIn(freshLogin: freshLogin)
                },
                cancelSignIn: { signIn?.cancel() },
                describeNode: nil,
                deviceName: { UIDevice.current.name },
                readKitFile: { nil },
                readInviteLink: { UIPasteboard.general.string },
                records: records,
                install: { device, session in
                    records.save(device)
                    records.saveSession(session)
                }))
    }
}
