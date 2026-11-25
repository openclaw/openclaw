import AppKit
import AuthenticationServices
import OpenClawKit
import UniformTypeIdentifiers

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

    /// Sign-in-first setup wired to this Mac's device store, node and Keychain.
    @MainActor
    static func setupService() -> OpenClawIDAccountSetupService {
        let configuration = Self.configuration()
        let signIn = configuration.map { Self.signIn($0) }
        let store = MacOpenClawIDDeviceStore.shared
        return OpenClawIDAccountSetupService(
            configuration: configuration,
            databaseURL: store.databaseURL,
            nodeInvitations: OnboardingNodeInvitationService(),
            environment: .init(
                signIn: { freshLogin in
                    guard let signIn else { throw OpenClawIDSignInError.refused }
                    return try await signIn.signIn(freshLogin: freshLogin)
                },
                cancelSignIn: { signIn?.cancel() },
                describeNode: { try await MacNodeModeCoordinator.shared.openClawIDEnrollmentDescription() },
                deviceName: { InstanceIdentity.displayName },
                readKitFile: { await Self.chooseKitFile() },
                readInviteLink: { NSPasteboard.general.string(forType: .string) },
                records: store.records,
                install: { device, session in
                    store.save(device)
                    store.saveSession(session)
                    MacOpenClawIDOperatorRoute.shared.stop()
                    MacNodeModeCoordinator.shared.selectOpenClawIDTarget(store.nodeTarget(device))
                    MacNodeModeCoordinator.shared.start()
                }))
    }

    /// The recovery code from a saved kit file. The file is read once and not kept.
    @MainActor
    static func chooseKitFile() async -> String? {
        guard AppLaunchRuntimePlan.current.allowsActivation else { return nil }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.plainText, .text, .data]
        panel.allowsMultipleSelection = false
        let response = await withCheckedContinuation { continuation in
            panel.begin { continuation.resume(returning: $0) }
        }
        guard response == .OK, let url = panel.url,
              let text = try? String(contentsOf: url, encoding: .utf8),
              let range = text.range(of: "OCK1(-?[0-9A-Za-z]){31}", options: .regularExpression)
        else { return nil }
        return String(text[range])
    }
}
