import Foundation
import Network
import OpenClawKit

enum GatewayConnectionIssue: Equatable {
    case none
    case tokenMissing
    case passwordMissing
    case unauthorized
    case pairingRequired(requestId: String?)
    case network
    case unknown(String)

    var requestId: String? {
        if case let .pairingRequired(requestId) = self {
            return requestId
        }
        return nil
    }

    var needsAuthCredentials: Bool {
        switch self {
        case .tokenMissing, .passwordMissing, .unauthorized:
            true
        default:
            false
        }
    }

    var needsPairing: Bool {
        if case .pairingRequired = self { return true }
        return false
    }

    static func detect(problem: GatewayConnectionProblem?) -> Self {
        guard let problem else { return .none }
        if problem.needsPairingApproval {
            return .pairingRequired(requestId: problem.requestId)
        }
        if problem.kind == .gatewayAuthTokenMissing {
            return .tokenMissing
        }
        if problem.kind == .gatewayAuthPasswordMissing {
            return .passwordMissing
        }
        if problem.needsCredentialUpdate {
            return .unauthorized
        }
        switch problem.kind {
        case .deviceIdentityRequired,
             .deviceSignatureExpired,
             .deviceNonceRequired,
             .deviceNonceMismatch,
             .deviceSignatureInvalid,
             .devicePublicKeyInvalid,
             .deviceIdMismatch,
             .tailscaleIdentityMissing,
             .tailscaleProxyMissing,
             .tailscaleWhoisFailed,
             .tailscaleIdentityMismatch,
             .authRateLimited:
            return .unauthorized
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            return .network
        case .unknown:
            return .unknown(problem.message)
        default:
            return .none
        }
    }

    static func detect(from statusText: String) -> Self {
        let trimmed = statusText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .none }
        let lower = trimmed.lowercased()

        if lower.contains("pairing required") || lower.contains("not_paired") || lower.contains("not paired") {
            return .pairingRequired(requestId: self.extractRequestId(from: trimmed))
        }
        if lower.contains("gateway token missing") {
            return .tokenMissing
        }
        if lower.contains("gateway password missing") {
            return .passwordMissing
        }
        if lower.contains("unauthorized") {
            return .unauthorized
        }
        if lower.contains("connection refused") ||
            lower.contains("timed out") ||
            lower.contains("network is unreachable") ||
            lower.contains("cannot find host") ||
            lower.contains("could not connect")
        {
            return .network
        }
        if lower.hasPrefix("gateway error:") {
            return .unknown(trimmed)
        }
        return .none
    }

    private static func extractRequestId(from statusText: String) -> String? {
        let marker = "requestId:"
        guard let range = statusText.range(of: marker) else { return nil }
        let suffix = statusText[range.upperBound...]
        let trimmed = suffix.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = trimmed.firstIndex(where: { ch in
            ch == ")" || ch.isWhitespace || ch == "," || ch == ";"
        }) ?? trimmed.endIndex
        let id = String(trimmed[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }
}

extension GatewayConnectionIssue {
    static let tailscaleSetupURL = URL(string: "https://tailscale.com/docs/install/ios")!

    /// These addresses suggest Tailscale, not proof of VPN state or permission to use plaintext.
    static func isTailnetEndpoint(_ host: String) -> Bool {
        var host = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        if host.hasSuffix(".ts.net") {
            return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
                !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
                    && label.utf8.allSatisfy { byte in
                        (97...122).contains(byte) || (48...57).contains(byte) || byte == 45
                    }
            }
        }
        if host.hasPrefix("["), host.hasSuffix("]") {
            host = String(host.dropFirst().dropLast())
        }
        if let address = IPv4Address(host) {
            let octets = host.split(separator: ".", omittingEmptySubsequences: false)
            guard octets.count == 4,
                  octets.allSatisfy({ octet in UInt8(octet).map { String($0) == octet } ?? false })
            else { return false }
            let bytes = address.rawValue
            return bytes[0] == 100 && (64...127).contains(bytes[1])
        }
        if let address = IPv6Address(host) {
            return address.rawValue.starts(with: [0xFD, 0x7A, 0x11, 0x5C, 0xA1, 0xE0])
        }
        return false
    }

    static func addingEndpointGuidance(
        to problem: GatewayConnectionProblem,
        host: String?) -> GatewayConnectionProblem
    {
        guard let host, self.isTailnetEndpoint(host),
              [.timeout, .connectionRefused, .reachabilityFailed].contains(problem.kind),
              problem.docsURL != self.tailscaleSetupURL
        else { return problem }
        let guidance = String(localized: """
        If this gateway uses Tailscale, install or open Tailscale on this device, \
        sign in to the same tailnet, and connect. Check that the gateway is online \
        and accessible to your device, then retry.
        """)
        let message = problem.localizedMessage + "\n\n" + guidance
        return GatewayConnectionProblem(
            kind: problem.kind,
            owner: problem.owner,
            title: problem.title,
            message: message,
            actionLabel: "Retry",
            titlePresentation: problem.titlePresentation,
            messagePresentation: .verbatim(message),
            actionCommand: problem.actionCommand,
            docsURL: self.tailscaleSetupURL,
            requestId: problem.requestId,
            retryable: problem.retryable,
            pauseReconnect: problem.pauseReconnect,
            technicalDetails: problem.technicalDetails,
            tlsStoreKey: problem.tlsStoreKey,
            tlsExpectedFingerprint: problem.tlsExpectedFingerprint,
            tlsObservedFingerprint: problem.tlsObservedFingerprint,
            tlsSystemTrustOk: problem.tlsSystemTrustOk)
    }
}
