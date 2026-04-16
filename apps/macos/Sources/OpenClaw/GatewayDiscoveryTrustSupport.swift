import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawKit

@MainActor
enum GatewayDiscoveryTrustSupport {
    struct Deps {
        var confirmSSHSelection: @MainActor @Sendable (_ params: SSHSelectionPrompt) -> Bool
        var probeTLSFingerprint: @Sendable (_ url: URL) async -> String?
        var confirmDirectSelection: @MainActor @Sendable (_ params: DirectSelectionPrompt) -> Bool
        var saveTLSFingerprint: @Sendable (_ storeKey: String, _ fingerprint: String) -> Void
        var loadPinnedTLSFingerprint: @Sendable (_ url: URL) -> String?
        var showSelectionFailure: @MainActor @Sendable (_ title: String, _ message: String) -> Void

        static let live = Deps(
            confirmSSHSelection: { params in
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = "Use discovered SSH gateway?"
                alert.informativeText = """
                "\(params.gatewayName)" resolves to \(params.host):\(params.port) over local network discovery.

                OpenClaw will save this SSH target as \(params.target).
                The connection will only work if this host key is already trusted in your local SSH
                configuration.
                """
                alert.addButton(withTitle: "Use Gateway")
                alert.addButton(withTitle: "Cancel")
                return alert.runModal() == .alertFirstButtonReturn
            },
            probeTLSFingerprint: { url in
                await withCheckedContinuation { continuation in
                    let probe = GatewayTLSFingerprintProbe(url: url, timeoutSeconds: 3) { fingerprint in
                        continuation.resume(returning: fingerprint)
                    }
                    probe.start()
                }
            },
            confirmDirectSelection: { params in
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = params.replacesExistingTrust
                    ? "Replace discovered gateway certificate trust?"
                    : "Trust discovered gateway certificate?"
                alert.informativeText = params.replacesExistingTrust
                    ? """
                    "\(params.gatewayName)" at \(params.host):\(params.port) now presents a different SHA-256 TLS fingerprint.

                    Verify this new fingerprint on the gateway host before replacing the pin OpenClaw already saved for future direct connections:
                    \(params.fingerprint)
                    """
                    : """
                    "\(params.gatewayName)" resolves to \(params.host):\(params.port) over local network discovery.

                    Verify this SHA-256 TLS fingerprint on the gateway host before trusting it.
                    OpenClaw will pin it for future direct connections:
                    \(params.fingerprint)
                    """
                alert.addButton(withTitle: "Trust Gateway")
                alert.addButton(withTitle: "Cancel")
                return alert.runModal() == .alertFirstButtonReturn
            },
            saveTLSFingerprint: { storeKey, fingerprint in
                GatewayTLSStore.saveFingerprint(fingerprint, stableID: storeKey)
            },
            loadPinnedTLSFingerprint: { url in
                GatewayTLSPinningSupport.pinnedFingerprint(url: url)
            },
            showSelectionFailure: { title, message in
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = title
                alert.informativeText = message
                alert.addButton(withTitle: "OK")
                alert.runModal()
            })
    }

    struct SSHSelectionPrompt: Equatable {
        let gatewayName: String
        let target: String
        let host: String
        let port: Int
    }

    struct DirectSelectionPrompt: Equatable {
        let gatewayName: String
        let host: String
        let port: Int
        let fingerprint: String
        let replacesExistingTrust: Bool
    }

    static func confirmSelection(
        gateway: GatewayDiscoveryModel.DiscoveredGateway,
        transport: AppState.RemoteTransport,
        deps: Deps = .live) async -> Bool
    {
        switch transport {
        case .ssh:
            guard let target = GatewayDiscoveryHelpers.sshTarget(for: gateway),
                  let parsed = CommandResolver.parseSSHTarget(target)
            else {
                deps.showSelectionFailure(
                    "Gateway selection failed",
                    "OpenClaw could not resolve an SSH target for \(gateway.displayName).")
                return false
            }
            guard !Task.isCancelled else {
                return false
            }
            return deps.confirmSSHSelection(SSHSelectionPrompt(
                gatewayName: gateway.displayName,
                target: target,
                host: parsed.host,
                port: parsed.port))

        case .direct:
            guard let rawUrl = GatewayDiscoveryHelpers.directUrl(for: gateway),
                  let url = URL(string: rawUrl)
            else {
                deps.showSelectionFailure(
                    "Gateway selection failed",
                    "OpenClaw could not resolve a direct gateway URL for \(gateway.displayName).")
                return false
            }
            // Loopback ws:// endpoints do not cross the LAN trust boundary that requires certificate pinning.
            guard url.scheme?.lowercased() == "wss" else {
                return true
            }
            guard let endpoint = GatewayDiscoveryHelpers.serviceEndpoint(for: gateway),
                  let storeKey = GatewayTLSPinningSupport.storeKey(host: endpoint.host, port: endpoint.port)
            else {
                deps.showSelectionFailure(
                    "Gateway selection failed",
                    "OpenClaw could not resolve a TLS pinning key for \(gateway.displayName).")
                return false
            }
            let existingFingerprint = deps.loadPinnedTLSFingerprint(url)
            let fingerprint = await deps.probeTLSFingerprint(url)
            guard !Task.isCancelled else {
                return false
            }
            guard let fingerprint else {
                deps.showSelectionFailure(
                    "Gateway certificate check failed",
                    """
                    OpenClaw could not read the TLS fingerprint for \(endpoint.host):\(endpoint.port).
                    Try again after verifying the gateway is reachable.
                    """)
                return false
            }
            if existingFingerprint == fingerprint {
                return true
            }
            guard deps.confirmDirectSelection(DirectSelectionPrompt(
                gatewayName: gateway.displayName,
                host: endpoint.host,
                port: endpoint.port,
                fingerprint: fingerprint,
                replacesExistingTrust: existingFingerprint != nil))
            else {
                return false
            }
            guard !Task.isCancelled else {
                return false
            }
            deps.saveTLSFingerprint(storeKey, fingerprint)
            return true
        }
    }
}
