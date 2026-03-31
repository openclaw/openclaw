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
        var loadTLSFingerprint: @Sendable (_ storeKey: String) -> String?
        var showSelectionFailure: @MainActor @Sendable (_ title: String, _ message: String) -> Void

        static let live = Deps(
            confirmSSHSelection: { params in
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = "Use discovered SSH gateway?"
                alert.informativeText = """
                "\(params.gatewayName)" resolves to \(params.host):\(params.port) over local network discovery.

                OpenClaw will save this SSH target as \(params.target). The connection will only work if this host key is already trusted in your local SSH configuration.
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
                alert.messageText = "Trust discovered gateway certificate?"
                alert.informativeText = """
                "\(params.gatewayName)" resolves to \(params.host):\(params.port) over local network discovery.

                OpenClaw will pin this SHA-256 TLS fingerprint for direct connections:
                \(params.fingerprint)
                """
                alert.addButton(withTitle: "Trust Gateway")
                alert.addButton(withTitle: "Cancel")
                return alert.runModal() == .alertFirstButtonReturn
            },
            saveTLSFingerprint: { storeKey, fingerprint in
                GatewayTLSStore.saveFingerprint(fingerprint, stableID: storeKey)
            },
            loadTLSFingerprint: { storeKey in
                GatewayTLSStore.loadFingerprint(stableID: storeKey)
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

    struct SSHSelectionPrompt: Equatable, Sendable {
        let gatewayName: String
        let target: String
        let host: String
        let port: Int
    }

    struct DirectSelectionPrompt: Equatable, Sendable {
        let gatewayName: String
        let host: String
        let port: Int
        let fingerprint: String
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
            if deps.loadTLSFingerprint(storeKey) != nil {
                return true
            }
            guard let fingerprint = await deps.probeTLSFingerprint(url) else {
                deps.showSelectionFailure(
                    "Gateway certificate check failed",
                    "OpenClaw could not read the TLS fingerprint for \(endpoint.host):\(endpoint.port). Try again after verifying the gateway is reachable.")
                return false
            }
            guard deps.confirmDirectSelection(DirectSelectionPrompt(
                gatewayName: gateway.displayName,
                host: endpoint.host,
                port: endpoint.port,
                fingerprint: fingerprint))
            else {
                return false
            }
            deps.saveTLSFingerprint(storeKey, fingerprint)
            return true
        }
    }
}
