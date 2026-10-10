import Foundation
import OpenClawKit
import OSLog

enum GatewayTLSRenewalDecline: String, Sendable {
    case configuredPin = "configured-pin"
    case notPinMismatch = "not-pin-mismatch"
    case systemTrustFailed = "system-trust-failed"
    case insecureScheme = "not-wss"
    case pinStoreMismatch = "pin-store-mismatch"
    case hostMismatch = "host-mismatch"
    case portMismatch = "port-mismatch"
    case noTLSRoute = "no-tls-route"
    case certificateUnavailable = "certificate-unavailable"
    case noLearnedPin = "no-learned-pin"
    case cancelled
    case pinChanged = "pin-changed"
}

struct GatewayTLSRoute: Equatable, Sendable {
    let params: GatewayTLSParams
    let allowsTrustedPinReplacement: Bool

    static func resolve(
        url: URL,
        connectionMode: AppState.ConnectionMode,
        configuredFingerprint: String?,
        storeKey: String? = nil) -> GatewayTLSRoute?
    {
        guard url.scheme?.lowercased() == "wss" else { return nil }
        let storeKey = storeKey ?? self.storeKey(for: url)
        let stored = GatewayTLSStore.loadFingerprint(stableID: storeKey)
        return self.resolve(
            url: url,
            connectionMode: connectionMode,
            configuredFingerprint: configuredFingerprint,
            storedFingerprint: stored,
            storeKey: storeKey)
    }

    static func resolve(
        url: URL,
        connectionMode: AppState.ConnectionMode,
        configuredFingerprint: String?,
        storedFingerprint: String?,
        storeKey: String? = nil) -> GatewayTLSRoute?
    {
        guard url.scheme?.lowercased() == "wss" else { return nil }
        let storeKey = storeKey ?? self.storeKey(for: url)
        let configured = connectionMode == .remote
            ? configuredFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            : nil
        let expected = configured ?? storedFingerprint
        return GatewayTLSRoute(
            params: GatewayTLSParams(
                required: true,
                expectedFingerprint: expected,
                allowTOFU: expected == nil,
                storeKey: storeKey),
            allowsTrustedPinReplacement: configured == nil)
    }

    static func storeKey(for url: URL) -> String {
        let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "gateway"
        return "\(host):\(url.port ?? 443)"
    }

    static func hasSameConnectionIdentity(
        _ lhs: GatewayTLSRoute?,
        _ rhs: GatewayTLSRoute?) -> Bool
    {
        switch (lhs, rhs) {
        case (nil, nil):
            true
        case let (lhs?, rhs?):
            lhs.hasSameConnectionIdentity(as: rhs)
        default:
            false
        }
    }

    func hasSameConnectionIdentity(as other: GatewayTLSRoute) -> Bool {
        if self == other {
            return true
        }
        guard self.params.required == other.params.required,
              self.params.storeKey == other.params.storeKey,
              self.allowsTrustedPinReplacement,
              other.allowsTrustedPinReplacement
        else { return false }

        let persistedRoute: GatewayTLSRoute
        if self.params.allowTOFU, self.params.expectedFingerprint == nil {
            persistedRoute = other
        } else if other.params.allowTOFU, other.params.expectedFingerprint == nil {
            persistedRoute = self
        } else {
            return false
        }
        guard !persistedRoute.params.allowTOFU,
              let storeKey = persistedRoute.params.storeKey,
              let expectedFingerprint = persistedRoute.params.expectedFingerprint
        else { return false }
        return GatewayTLSStore.claimedFirstUseFingerprint(stableID: storeKey) == expectedFingerprint
    }

    /// Only a fresh, read-only connection preflight may cross a learned-pin renewal.
    /// Connected routes and mutations continue to use hasSameConnectionIdentity.
    static func hasSameTrustPolicy(_ lhs: GatewayTLSRoute?, _ rhs: GatewayTLSRoute?) -> Bool {
        if lhs == rhs { return true }
        guard let lhs, let rhs,
              lhs.allowsTrustedPinReplacement, rhs.allowsTrustedPinReplacement
        else { return false }
        return lhs.params.required == rhs.params.required && lhs.params.storeKey == rhs.params.storeKey
    }

    func trustedPinReplacementDecline(
        url: URL,
        failure: GatewayTLSValidationFailure) -> GatewayTLSRenewalDecline?
    {
        let routeHost = url.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().nonEmpty
        let challengedHost = failure.host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().nonEmpty
        guard self.allowsTrustedPinReplacement else { return .configuredPin }
        guard failure.kind == .pinMismatch else { return .notPinMismatch }
        guard failure.systemTrustOk else { return .systemTrustFailed }
        guard url.scheme?.lowercased() == "wss" else { return .insecureScheme }
        guard failure.storeKey == self.params.storeKey else { return .pinStoreMismatch }
        guard let routeHost else { return .hostMismatch }
        guard challengedHost == routeHost else { return .hostMismatch }
        guard failure.port == (url.port ?? 443) else { return .portMismatch }

        // Stored pins are learned only after platform trust succeeds. Ordinary CA
        // renewal follows that same hostname-validated trust contract; a configured
        // fingerprint remains a strict pin through allowsTrustedPinReplacement.
        return nil
    }
}

enum GatewayTLSRepairCoordinator {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.tls-repair")

    /// Keep lifecycle-owner validation and repair on the same executor. The store's
    /// conditional update owns cross-connection CAS, not a separate actor hop.
    nonisolated static func repairOnCurrentExecutor(
        route: GatewayTLSRoute?,
        url: URL,
        failure: GatewayTLSValidationFailure) -> Bool
    {
        guard let decline = self.repairDecline(route: route, url: url, failure: failure) else { return true }
        let port = failure.port.map(String.init) ?? "default"
        self.logger.notice(
            """
            gateway TLS pin renewal declined: \(decline.rawValue, privacy: .public) \
            failure=\(failure.kind.rawValue, privacy: .public) \
            host=\(failure.host, privacy: .public) port=\(port, privacy: .public)
            """)
        return false
    }

    private nonisolated static func repairDecline(
        route: GatewayTLSRoute?,
        url: URL,
        failure: GatewayTLSValidationFailure) -> GatewayTLSRenewalDecline?
    {
        guard let route else { return .noTLSRoute }
        if let decline = route.trustedPinReplacementDecline(url: url, failure: failure) { return decline }
        guard let storeKey = failure.storeKey else { return .pinStoreMismatch }
        guard let observedFingerprint = failure.observedFingerprint else { return .certificateUnavailable }

        guard !Task.isCancelled else { return .cancelled }
        let current = GatewayTLSStore.loadFingerprint(stableID: storeKey)
        // Keychain reads can block; cancellation may arrive while they are in flight.
        guard !Task.isCancelled else { return .cancelled }
        if current == observedFingerprint {
            return nil
        }
        guard route.params.expectedFingerprint != nil,
              let failedFingerprint = failure.expectedFingerprint
        else { return .noLearnedPin }
        if GatewayTLSStore.replaceFingerprint(
            observedFingerprint,
            ifCurrent: failedFingerprint,
            stableID: storeKey)
        {
            return nil
        }
        // Another connection may have won after our read. Only its identical
        // trusted certificate satisfies this repair; never overwrite a different pin.
        guard !Task.isCancelled else { return .cancelled }
        let winner = GatewayTLSStore.loadFingerprint(stableID: storeKey)
        guard !Task.isCancelled else { return .cancelled }
        return winner == observedFingerprint ? nil : .pinChanged
    }
}
