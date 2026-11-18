import Foundation
import Observation
import OpenClawKit
import SwiftUI

/// An unsaved connection form. Only AppState publishes the accepted route and authentication bundle.
@MainActor
@Observable
final class PrimaryGatewayConnectionDraft {
    private let state: AppState
    private let snapshot: AppState.PrimaryGatewaySnapshot
    private let originalInput: String
    private let originalFingerprint: String?
    var transport: AppState.RemoteTransport {
        didSet { if self.transport != oldValue { self.clearRouteCredentials() } }
    }

    var input: String {
        didSet { if self.input != oldValue { self.clearRouteCredentials() } }
    }

    var sshTarget: String {
        didSet {
            if self.sshTarget != oldValue {
                self.clearRouteCredentials()
                self.hostKeyPolicy = .strict
                self.identity = ""
                self.projectRoot = ""
                self.cliPath = ""
            }
        }
    }

    var remotePort: String {
        didSet { if self.remotePort != oldValue { self.clearRouteCredentials() } }
    }

    var token: String {
        didSet { if self.token != oldValue { self.replacedToken = true } }
    }

    var password: String {
        didSet { if self.password != oldValue { self.replacedPassword = true } }
    }

    var identity: String
    var projectRoot: String
    var cliPath: String
    private var unsupportedToken: Bool
    private var unsupportedPassword: Bool
    private var replacedToken = false
    private var replacedPassword = false
    private var hostKeyPolicy: CommandResolver.SSHHostKeyPolicy
    let hasEnvironmentAuthOverride: Bool

    init(state: AppState) {
        self.state = state
        let snapshot = state.primaryGatewaySnapshot()
        self.snapshot = snapshot
        let root = snapshot.root
        let gateway = root["gateway"] as? [String: Any] ?? [:]
        let remote = gateway["remote"] as? [String: Any] ?? [:]
        let settings = CommandResolver.connectionSettings(configRoot: root)
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        self.transport = ConnectionModeResolver.resolve(root: root).mode == .unconfigured ? .direct : resolution
            .transport
        let input = resolution.transport == .direct
            ? resolution.directURL?.absoluteString ?? GatewayRemoteConfig.resolveUrlString(root: root) ?? "" : ""
        self.input = input
        self.originalInput = input
        self.originalFingerprint = remote["tlsFingerprint"] as? String
        self.sshTarget = settings.target
        self.remotePort = settings.mode == .remote && resolution.transport == .ssh
            ? String(RemotePortTunnel.ports(
                root: root,
                sshHost: CommandResolver.parseSSHTarget(settings.target)?.host ?? "").remote)
            : "18789"
        self.token = remote["token"] as? String ?? ""
        self.password = remote["password"] as? String ?? ""
        self.unsupportedToken = remote["token"] != nil && !(remote["token"] is String)
        self.unsupportedPassword = remote["password"] != nil && !(remote["password"] is String)
        self.identity = settings.identity
        self.projectRoot = settings.projectRoot
        self.cliPath = settings.cliPath
        self.hostKeyPolicy = settings.sshHostKeyPolicy
        self.hasEnvironmentAuthOverride = ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"].contains {
            !(ProcessInfo.processInfo.environment[$0]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        }
    }

    private func clearRouteCredentials() {
        self.token = ""
        self.password = ""
        self.unsupportedToken = false
        self.unsupportedPassword = false
    }

    func save() throws {
        guard !self.unsupportedToken || self.replacedToken,
              !self.unsupportedPassword || self.replacedPassword
        else {
            throw GatewayConnectionDraftError.credentialRequired
        }
        let configuration: PrimaryGatewayControlConfiguration
        switch self.transport {
        case .direct:
            guard let link = GatewayConnectDeepLink.fromSetupInput(self.input), link.isValidEndpoint,
                  let parsedURL = link.websocketURL
            else { throw GatewayConnectionDraftError.invalidSetup }
            // A no-op edit must not normalize a saved URL into a different device-token route key.
            let url = self.input == self.originalInput ? URL(string: self.originalInput) ?? parsedURL : parsedURL
            configuration = .direct(
                url: url,
                token: self.token.isEmpty ? link.token : self.token,
                password: self.password.isEmpty ? link.password : self.password,
                tlsFingerprint: link.tlsFingerprintSha256 ??
                    (self.input == self.originalInput ? self.originalFingerprint : nil))
        case .ssh:
            guard let port = Int(self.remotePort.trimmingCharacters(in: .whitespacesAndNewlines)),
                  (1...65535).contains(port)
            else { throw PrimaryGatewayControlError.invalidPort }
            configuration = .ssh(
                target: self.sshTarget,
                remotePort: port,
                localPort: nil,
                identity: self.identity,
                hostKeyPolicy: self.hostKeyPolicy,
                token: self.token,
                password: self.password)
        }
        try self.state.setPrimaryGateway(configuration, replacing: self.snapshot)
        if self.transport == .ssh {
            self.state.remoteProjectRoot = self.projectRoot
            self.state.remoteCliPath = self.cliPath
        }
    }
}

private enum GatewayConnectionDraftError: LocalizedError {
    case invalidSetup
    case credentialRequired

    var errorDescription: String? {
        switch self {
        case .invalidSetup:
            "Enter a trusted Gateway address or a current setup code. " +
                "Ask the Gateway owner for a new code if it expired."
        case .credentialRequired:
            "This connection uses a credential reference that this form cannot edit. " +
                "Enter a token or password, or cancel."
        }
    }
}

struct PrimaryGatewayConnectionEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: PrimaryGatewayConnectionDraft
    @State private var error: String?
    let onSave: () -> Void

    init(state: AppState, onSave: @escaping () -> Void = {}) {
        _draft = State(initialValue: PrimaryGatewayConnectionDraft(state: state))
        self.onSave = onSave
    }

    var body: some View {
        @Bindable var draft = self.draft
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect to a Gateway").font(.title2.weight(.semibold))
            Text("Get the address or setup code from the Gateway owner through a source you trust. " +
                "A Nearby listing does not verify its owner. Your current connection stays in place until you save.")
                .fixedSize(horizontal: false, vertical: true)
            Form {
                Picker("Connection", selection: $draft.transport) {
                    Text("Gateway address or setup code").tag(AppState.RemoteTransport.direct)
                    Text("SSH tunnel").tag(AppState.RemoteTransport.ssh)
                }
                if self.draft.transport == .direct {
                    TextField("Address or setup code", text: $draft.input)
                        .textFieldStyle(.roundedBorder)
                    Text("A setup code supplies the address and available certificate information automatically. " +
                        "For token or password authentication, enter the ordinary Gateway credential below.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    TextField("SSH target", text: $draft.sshTarget, prompt: Text("user@host[:port]"))
                    TextField("Gateway port on the remote host", text: $draft.remotePort)
                    DisclosureGroup("SSH details") {
                        TextField("Identity file", text: $draft.identity)
                        TextField("Project root", text: $draft.projectRoot)
                        TextField("CLI path", text: $draft.cliPath)
                    }
                }
                SecureField("Gateway token", text: $draft.token)
                SecureField("Gateway password", text: $draft.password)
                if self.draft.hasEnvironmentAuthOverride {
                    Text("Authentication from this app's launch environment overrides these fields for all " +
                        "Gateway connections. Update that environment before connecting to a different Gateway.")
                        .font(.caption).foregroundStyle(.orange)
                }
                Text("Use the credential for this destination. Leave both fields empty only if this route " +
                    "already has device pairing or does not require a shared credential. " +
                    "Changing the destination clears this form's saved credentials.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = self.error {
                Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { self.dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save connection") {
                    do {
                        try self.draft.save()
                        self.onSave()
                        self.dismiss()
                    } catch {
                        if case PrimaryGatewayControlError.conflictingEdits = error {
                            self.error = "Connection settings changed while this form was open. Cancel and reopen " +
                                "Change connection, then resolve any connection conflict shown in the app."
                        } else {
                            self.error = error.localizedDescription
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 520)
    }
}
