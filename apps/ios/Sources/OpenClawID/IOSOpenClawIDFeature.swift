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

    /// Connects chat, the dashboard and, when this device runs tools, the node to the saved claw.
    /// Returns false when this device has no OpenClaw ID claw.
    @MainActor
    @discardableResult
    static func connect(appModel: NodeAppModel, gatewayController: GatewayConnectionController) async -> Bool {
        let options = await gatewayController.makeConnectOptions(deviceAuthGatewayID: nil)
        do {
            guard let config = try await IOSOpenClawIDRoute.shared.connectConfig(options: options) else { return false }
            appModel.applyGatewayConnectConfig(config, forceReconnect: true)
        } catch {
            self.logger.error("OpenClaw ID route failed: \(String(reflecting: error), privacy: .public)")
        }
        return true
    }

    /// PKCE sign-in presented over this app's key window.
    @MainActor
    static func signIn(_ configuration: OpenClawIDConfiguration) -> OpenClawIDSignIn? {
        OpenClawIDSignIn(configuration: configuration) {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }

    /// What this device offers its claw as a node: the same surface its node session advertises.
    @MainActor
    static func nodeDescription(gatewayController: GatewayConnectionController) async throws
        -> OpenClawIDNodeEnrollmentDescription
    {
        let options = await gatewayController.makeConnectOptions(deviceAuthGatewayID: nil)
        return try OpenClawIDNodeEnrollmentDescription(
            displayName: String((options.clientDisplayName ?? UIDevice.current.name).prefix(64)),
            platform: "ios",
            commands: options.commands,
            caps: options.caps)
    }

    /// Sign-in-first setup for this device. An owner device also joins as a node, so the claw can use
    /// it for tools; a member device has chat and the dashboard only.
    @MainActor
    static func setupService(gatewayController: GatewayConnectionController) -> OpenClawIDAccountSetupService {
        let configuration = Self.configuration()
        let signIn = configuration.flatMap(Self.signIn)
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
                describeNode: { try await Self.nodeDescription(gatewayController: gatewayController) },
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
