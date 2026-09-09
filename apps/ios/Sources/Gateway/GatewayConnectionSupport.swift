import Foundation
import OpenClawKit

enum GatewaySetupRouteProbeBudget {
    static let tcpConnectTimeoutSeconds = 2.0
}

func defaultGatewayTCPReachabilityProbe(
    host: String,
    port: Int,
    timeoutSeconds: Double,
    queueLabel: String) async -> Bool
{
    await TCPProbe.probe(host: host, port: port, timeoutSeconds: timeoutSeconds, queueLabel: queueLabel)
}

struct GatewayPendingTrustConnect {
    let url: URL
    let stableID: String
    let isManual: Bool
    let authOverride: GatewayConnectionController.ManualAuthOverride?
    let allowStoredDeviceAuth: Bool
    let suppressionLease: GatewayConnectionController.AutoConnectSuppressionLease
    let gatewayGeneration: UInt64?
}

extension GatewayConnectionController {
    enum ConnectionAttemptResult: Equatable {
        case accepted
        case failed(String)
        case superseded
    }

    enum DiscoveredGatewayConnectionAvailability: Equatable {
        case available
        case secureTransportRequired

        var canConnect: Bool {
            self == .available
        }

        var actionTitle: String {
            switch self {
            case .available:
                String(localized: "Connect")
            case .secureTransportRequired:
                String(localized: "TLS required")
            }
        }

        var guidanceText: String? {
            switch self {
            case .available:
                nil
            case .secureTransportRequired:
                String(localized: """
                Enable Gateway TLS, or enter your Tailscale Serve HTTPS host in Manual Setup. \
                Use Unencrypted only with a trusted private-LAN address.
                """)
            }
        }
    }

    func discoveredGatewayConnectionAvailability(
        _ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> DiscoveredGatewayConnectionAvailability
    {
        if gateway.tlsEnabled || GatewayTLSStore.loadFingerprint(stableID: gateway.stableID) != nil {
            return .available
        }
        return .secureTransportRequired
    }

    func preferredDiscoveredGateway() -> GatewayDiscoveryModel.DiscoveredGateway? {
        self.gateways.first(where: {
            self.discoveredGatewayConnectionAvailability($0).canConnect
        }) ?? self.gateways.first
    }

    func mostRecentlyConnectedManualGateway() -> GatewaySettingsStore.GatewayRegistryEntry? {
        GatewaySettingsStore.loadGatewayRegistry().entries
            .filter { $0.kind == .manual }
            .max { lhs, rhs in
                let lhsConnected = lhs.lastConnectedAtMs ?? Int.min
                let rhsConnected = rhs.lastConnectedAtMs ?? Int.min
                if lhsConnected != rhsConnected { return lhsConnected < rhsConnected }
                return GatewayStableIdentifier.sortsBefore(rhs.stableID, lhs.stableID)
            }
    }

    func updateLastDiscoveredGateway(from gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        let defaults = UserDefaults.standard
        let preferred = GatewayStableIdentifier.exact(
            defaults.string(forKey: "gateway.preferredStableID"))
        let existingLast = GatewayStableIdentifier.exact(
            defaults.string(forKey: "gateway.lastDiscoveredStableID"))

        // Avoid overriding user intent (preferred/lastDiscovered are also set on manual Connect).
        guard preferred == nil, existingLast == nil else { return }
        guard let first = gateways.first else { return }

        defaults.set(first.stableID, forKey: "gateway.lastDiscoveredStableID")
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(first.stableID)
    }

    func resolveDiscoveredTLSParams(
        gateway: GatewayDiscoveryModel.DiscoveredGateway) -> GatewayTLSParams?
    {
        let stableID = gateway.stableID
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)

        // Never let unauthenticated discovery (TXT) override a stored pin.
        if let stored {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: false,
                storeKey: stableID)
        }

        if gateway.tlsEnabled || gateway.tlsFingerprintSha256 != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: nil,
                allowTOFU: false,
                storeKey: stableID)
        }

        return nil
    }

    func tlsProbeFailureProblem(
        _ failure: GatewayTLSFingerprintProbeFailure,
        host: String,
        port: Int) -> GatewayConnectionProblem
    {
        let kind: GatewayConnectionProblem.Kind
        let title: String
        let message: String
        switch failure {
        case .endpointUnreachable:
            kind = .reachabilityFailed
            title = "Gateway is not reachable"
            message = String(
                format: String(localized: """
                Can't reach gateway at %1$@:%2$@. Check the address and your network connection.
                """),
                host,
                String(port))
        case .tlsHandshakeTimeout:
            kind = .timeout
            title = "TLS verification timed out"
            message = String(
                format: String(localized: """
                TLS fingerprint verification timed out for %1$@:%2$@. \
                The host was reached, but TLS did not finish in time.
                """),
                host,
                String(port))
        case .tlsUnavailable:
            kind = .tlsCertificateUnavailable
            title = "Secure gateway unavailable"
            message = String(
                format: String(localized: """
                No secure gateway endpoint was detected at %1$@:%2$@. \
                Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address \
                with Unencrypted selected.
                """),
                host,
                String(port))
        case .certificateUnavailable:
            kind = .tlsCertificateUnavailable
            title = "Gateway certificate unavailable"
            message = String(
                format: String(
                    localized: "Could not read the TLS certificate from %1$@:%2$@."),
                host,
                String(port))
        }
        return GatewayConnectionProblem(
            kind: kind,
            owner: .network,
            title: title,
            message: message,
            actionLabel: "Retry",
            messagePresentation: .verbatim(message),
            docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
            retryable: true,
            pauseReconnect: false)
    }
}
