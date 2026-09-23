import Foundation

public struct GatewayConnectionProblem: Equatable, Sendable {
    public enum PresentationText: Equatable, Sendable {
        case localized(String)
        case localizedFormat(String, [String])
        case verbatim(String)
    }

    public enum Kind: String, Equatable, Sendable {
        case gatewayAuthTokenMissing
        case gatewayAuthTokenMismatch
        case gatewayAuthTokenNotConfigured
        case gatewayAuthPasswordMissing
        case gatewayAuthPasswordMismatch
        case gatewayAuthPasswordNotConfigured
        case bootstrapTokenInvalid
        case deviceTokenMismatch
        case deviceTokenScopeMismatch
        case pairingRequired
        case pairingRoleUpgradeRequired
        case pairingScopeUpgradeRequired
        case pairingMetadataUpgradeRequired
        case protocolMismatch
        case deviceIdentityRequired
        case deviceSignatureExpired
        case deviceNonceRequired
        case deviceNonceMismatch
        case deviceSignatureInvalid
        case devicePublicKeyInvalid
        case deviceIdMismatch
        case tailscaleIdentityMissing
        case tailscaleProxyMissing
        case tailscaleWhoisFailed
        case tailscaleIdentityMismatch
        case authRateLimited
        case timeout
        case connectionRefused
        case reachabilityFailed
        case websocketCancelled
        case tlsPinMismatch
        case tlsCertificateUntrusted
        case tlsCertificateUnavailable
        case unknown
    }

    public enum Owner: String, Equatable, Sendable {
        case gateway
        case iphone
        case both
        case network
        case unknown
    }

    public let kind: Kind
    public let owner: Owner
    public let title: String
    public let message: String
    public let actionLabel: String?
    public let titlePresentation: PresentationText
    public let messagePresentation: PresentationText
    public let actionLabelPresentation: PresentationText?
    public let actionCommand: String?
    public let docsURL: URL?
    public let requestId: String?
    public let retryable: Bool
    public let pauseReconnect: Bool
    public let technicalDetails: String?
    public let tlsStoreKey: String?
    public let tlsExpectedFingerprint: String?
    public let tlsObservedFingerprint: String?
    public let tlsSystemTrustOk: Bool

    public init(
        kind: Kind,
        owner: Owner,
        title: String,
        message: String,
        actionLabel: String? = nil,
        titlePresentation: PresentationText? = nil,
        messagePresentation: PresentationText? = nil,
        actionLabelPresentation: PresentationText? = nil,
        actionCommand: String? = nil,
        docsURL: URL? = nil,
        requestId: String? = nil,
        retryable: Bool,
        pauseReconnect: Bool,
        technicalDetails: String? = nil,
        tlsStoreKey: String? = nil,
        tlsExpectedFingerprint: String? = nil,
        tlsObservedFingerprint: String? = nil,
        tlsSystemTrustOk: Bool = false)
    {
        self.kind = kind
        self.owner = owner
        self.title = title
        self.message = message
        self.actionLabel = Self.trimmedOrNil(actionLabel)
        self.titlePresentation = titlePresentation ?? .localized(title)
        self.messagePresentation = messagePresentation ?? .localized(message)
        self.actionLabelPresentation = actionLabelPresentation
            ?? self.actionLabel.map(PresentationText.localized)
        self.actionCommand = Self.trimmedOrNil(actionCommand)
        self.docsURL = docsURL
        self.requestId = Self.trimmedOrNil(requestId)
        self.retryable = retryable
        self.pauseReconnect = pauseReconnect
        self.technicalDetails = Self.trimmedOrNil(technicalDetails)
        self.tlsStoreKey = Self.trimmedOrNil(tlsStoreKey)
        self.tlsExpectedFingerprint = Self.trimmedOrNil(tlsExpectedFingerprint)
        self.tlsObservedFingerprint = Self.trimmedOrNil(tlsObservedFingerprint)
        self.tlsSystemTrustOk = tlsSystemTrustOk
    }

    public var needsPairingApproval: Bool {
        switch self.kind {
        case .pairingRequired, .pairingRoleUpgradeRequired, .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired, .deviceTokenScopeMismatch:
            true
        default:
            false
        }
    }

    public var needsCredentialUpdate: Bool {
        switch self.kind {
        case .gatewayAuthTokenMissing,
             .gatewayAuthTokenMismatch,
             .gatewayAuthTokenNotConfigured,
             .gatewayAuthPasswordMissing,
             .gatewayAuthPasswordMismatch,
             .gatewayAuthPasswordNotConfigured,
             .bootstrapTokenInvalid,
             .deviceTokenMismatch:
            true
        default:
            false
        }
    }

    public var suggestsOnboardingReset: Bool {
        self.kind == .gatewayAuthTokenMismatch
    }

    public var statusText: String {
        switch self.kind {
        case .pairingRequired, .pairingRoleUpgradeRequired, .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired, .protocolMismatch:
            if let requestId {
                return "\(self.title) (request ID: \(requestId))"
            }
            return self.title
        default:
            return self.title
        }
    }

    public var canTrustRotatedCertificate: Bool {
        self.kind == .tlsPinMismatch
            && self.tlsSystemTrustOk
            && self.tlsStoreKey != nil
            && self.tlsObservedFingerprint != nil
    }

    private static func trimmedOrNil(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

public enum GatewayConnectionProblemMapper {
    private struct AuthProblemDefaults {
        let kind: GatewayConnectionProblem.Kind
        let owner: GatewayConnectionProblem.Owner
        let title: String
        let message: String
        let actionLabel: String?
        let actionCommand: String?
        let docsURLString: String?
        let retryable: Bool
        let pauseReconnect: Bool
    }

    public static func map(
        error: Error,
        preserving previousProblem: GatewayConnectionProblem? = nil) -> GatewayConnectionProblem?
    {
        guard let nextProblem = self.rawMap(error) else {
            return nil
        }
        guard let previousProblem else {
            return nextProblem
        }
        if self.shouldPreserve(previousProblem: previousProblem, over: nextProblem) {
            return previousProblem
        }
        return nextProblem
    }

    public static func shouldPreserve(
        previousProblem: GatewayConnectionProblem,
        over nextProblem: GatewayConnectionProblem) -> Bool
    {
        if nextProblem.kind == .websocketCancelled {
            return previousProblem.pauseReconnect || previousProblem.requestId != nil
        }
        return false
    }

    public static func shouldPreserve(
        previousProblem: GatewayConnectionProblem,
        overDisconnectReason reason: String) -> Bool
    {
        let normalized = reason.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return false }
        if normalized.contains("cancelled") || normalized.contains("canceled") {
            return previousProblem.pauseReconnect || previousProblem.requestId != nil
        }
        return false
    }

    private static func rawMap(_ error: Error) -> GatewayConnectionProblem? {
        if let authError = error as? GatewayConnectAuthError {
            return self.map(authError)
        }
        if let responseError = error as? GatewayResponseError {
            return self.map(responseError)
        }
        if let tlsError = error as? GatewayTLSValidationError {
            return self.map(tlsError)
        }
        return self.mapTransportError(error)
    }

    private static func map(_ authError: GatewayConnectAuthError) -> GatewayConnectionProblem {
        switch authError.detail {
        case .authTokenMissing,
             .authTokenMismatch,
             .authTokenNotConfigured,
             .authPasswordMissing,
             .authPasswordMismatch,
             .authPasswordNotConfigured:
            self.gatewayCredentialProblem(for: authError)
        case .authBootstrapTokenInvalid, .authDeviceTokenMismatch, .authScopeMismatch:
            self.deviceCredentialProblem(for: authError)
        case .pairingRequired:
            self.pairingProblem(for: authError)
        case .protocolMismatch:
            self.protocolMismatchProblem(for: authError)
        case .controlUiDeviceIdentityRequired,
             .deviceIdentityRequired,
             .deviceAuthSignatureExpired,
             .deviceAuthNonceRequired,
             .deviceAuthNonceMismatch,
             .deviceAuthSignatureInvalid,
             .deviceAuthInvalid,
             .deviceAuthPublicKeyInvalid,
             .deviceAuthDeviceIdMismatch:
            self.deviceIdentityProblem(for: authError)
        case .authTailscaleIdentityMissing:
            self.problem(
                .init(
                    kind: .tailscaleIdentityMissing,
                    owner: .network,
                    title: "Tailscale identity check failed",
                    message: "This connection expected Tailscale identity headers, but they were not available.",
                    actionLabel: "Turn on Tailscale",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/tailscale",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authTailscaleProxyMissing:
            self.problem(
                .init(
                    kind: .tailscaleProxyMissing,
                    owner: .network,
                    title: "Tailscale identity check failed",
                    message: "The gateway expected a Tailscale auth proxy, but it was not configured.",
                    actionLabel: "Review Tailscale setup",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/tailscale",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authTailscaleWhoisFailed:
            self.problem(
                .init(
                    kind: .tailscaleWhoisFailed,
                    owner: .network,
                    title: "Tailscale identity check failed",
                    message: "The gateway could not verify this Tailscale client identity.",
                    actionLabel: "Review Tailscale setup",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/tailscale",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authTailscaleIdentityMismatch:
            self.problem(
                .init(
                    kind: .tailscaleIdentityMismatch,
                    owner: .network,
                    title: "Tailscale identity check failed",
                    message: "The forwarded Tailscale identity did not match the verified identity.",
                    actionLabel: "Review Tailscale setup",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/tailscale",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authRateLimited:
            self.problem(
                .init(
                    kind: .authRateLimited,
                    owner: .gateway,
                    title: "Too many failed attempts",
                    message: "The gateway is temporarily refusing new auth attempts after repeated failures.",
                    actionLabel: "Wait and retry",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/troubleshooting",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authRequired, .authUnauthorized, .authVerifiedUserRequired, .none:
            self.problem(
                .init(
                    kind: .unknown,
                    owner: .unknown,
                    title: "Gateway rejected the connection",
                    message: authError.message,
                    actionLabel: nil,
                    actionCommand: nil,
                    docsURLString: nil,
                    retryable: false,
                    pauseReconnect: authError.isNonRecoverable),
                authError: authError)
        }
    }

    private static func gatewayCredentialProblem(
        for authError: GatewayConnectAuthError) -> GatewayConnectionProblem
    {
        switch authError.detail {
        case .authTokenMissing:
            self.problem(
                .init(
                    kind: .gatewayAuthTokenMissing,
                    owner: .both,
                    title: "Gateway token required",
                    message: "This gateway requires an auth token, but this device did not send one.",
                    actionLabel: "Open Settings",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/authentication",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authTokenMismatch:
            self.problem(
                .init(
                    kind: .gatewayAuthTokenMismatch,
                    owner: .both,
                    title: "Gateway token is out of date",
                    message: "The token on this device does not match the gateway token.",
                    actionLabel: authError.canRetryWithDeviceToken ? "Retry once" : "Update gateway token",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/authentication",
                    retryable: authError.canRetryWithDeviceToken,
                    pauseReconnect: !authError.canRetryWithDeviceToken),
                authError: authError)
        case .authTokenNotConfigured:
            self.problem(
                .init(
                    kind: .gatewayAuthTokenNotConfigured,
                    owner: .gateway,
                    title: "Gateway token is not configured",
                    message: "This gateway is set to token auth, but no gateway token is configured on the gateway.",
                    actionLabel: "Fix on gateway",
                    actionCommand: "openclaw config set gateway.auth.token <new-token>",
                    docsURLString: "https://docs.openclaw.ai/gateway/authentication",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authPasswordMissing:
            self.problem(
                .init(
                    kind: .gatewayAuthPasswordMissing,
                    owner: .both,
                    title: "Gateway password required",
                    message: "This gateway requires a password, but this device did not send one.",
                    actionLabel: "Open Settings",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/authentication",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authPasswordMismatch:
            self.problem(
                .init(
                    kind: .gatewayAuthPasswordMismatch,
                    owner: .both,
                    title: "Gateway password is out of date",
                    message: "The saved password on this device does not match the gateway password.",
                    actionLabel: "Update password",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/authentication",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authPasswordNotConfigured:
            self.problem(
                .init(
                    kind: .gatewayAuthPasswordNotConfigured,
                    owner: .gateway,
                    title: "Gateway password is not configured",
                    message:
                    "This gateway is set to password auth, but no gateway password is configured on the gateway.",
                    actionLabel: "Fix on gateway",
                    actionCommand: "openclaw config set gateway.auth.password <new-password>",
                    docsURLString: "https://docs.openclaw.ai/gateway/authentication",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        default:
            // The dispatcher owns this category boundary; new credential failures must be routed there first.
            preconditionFailure("Unexpected gateway credential auth detail")
        }
    }

    private static func deviceCredentialProblem(
        for authError: GatewayConnectAuthError) -> GatewayConnectionProblem
    {
        let pairingCommand = self.approvalCommand(requestId: authError.requestId)

        return switch authError.detail {
        case .authBootstrapTokenInvalid:
            self.problem(
                .init(
                    kind: .bootstrapTokenInvalid,
                    owner: .iphone,
                    title: "Setup code expired",
                    message: "The setup QR or bootstrap token is no longer valid.",
                    actionLabel: "Scan QR again",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/platforms/ios",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authDeviceTokenMismatch:
            self.problem(
                .init(
                    kind: .deviceTokenMismatch,
                    owner: .both,
                    title: "This device's saved device token is no longer valid",
                    message: "The gateway rejected the stored device token for this role.",
                    actionLabel: "Repair pairing",
                    actionCommand: pairingCommand,
                    docsURLString: "https://docs.openclaw.ai/gateway/pairing",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .authScopeMismatch:
            self.problem(
                .init(
                    kind: .deviceTokenScopeMismatch,
                    owner: .both,
                    title: "Device permissions need approval",
                    message: "The gateway accepted this device token but rejected the requested operator scopes.",
                    actionLabel: "Review pairing",
                    actionCommand: pairingCommand,
                    docsURLString: "https://docs.openclaw.ai/gateway/pairing",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        default:
            // The dispatcher owns this category boundary; new device-token failures must be routed there first.
            preconditionFailure("Unexpected device credential auth detail")
        }
    }

    private static func deviceIdentityProblem(
        for authError: GatewayConnectAuthError) -> GatewayConnectionProblem
    {
        switch authError.detail {
        case .controlUiDeviceIdentityRequired, .deviceIdentityRequired:
            self.problem(
                .init(
                    kind: .deviceIdentityRequired,
                    owner: .iphone,
                    title: "Secure device identity is required",
                    message: "This connection must include a signed device identity before the gateway can bind "
                        + "permissions to this device.",
                    actionLabel: "Retry from the app",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/platforms/ios",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .deviceAuthSignatureExpired:
            self.problem(
                .init(
                    kind: .deviceSignatureExpired,
                    owner: .iphone,
                    title: "Secure handshake expired",
                    message: "The device signature is too old to use.",
                    actionLabel: "Check device time",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/troubleshooting",
                    retryable: true,
                    pauseReconnect: true),
                authError: authError)
        case .deviceAuthNonceRequired:
            self.problem(
                .init(
                    kind: .deviceNonceRequired,
                    owner: .iphone,
                    title: "Secure handshake is incomplete",
                    message: "The gateway expected a one-time challenge response, but the nonce was missing.",
                    actionLabel: "Retry",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/troubleshooting",
                    retryable: true,
                    pauseReconnect: true),
                authError: authError)
        case .deviceAuthNonceMismatch:
            self.problem(
                .init(
                    kind: .deviceNonceMismatch,
                    owner: .iphone,
                    title: "Secure handshake did not match",
                    message: "The challenge response was stale or mismatched.",
                    actionLabel: "Retry",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/troubleshooting",
                    retryable: true,
                    pauseReconnect: true),
                authError: authError)
        case .deviceAuthSignatureInvalid, .deviceAuthInvalid:
            self.problem(
                .init(
                    kind: .deviceSignatureInvalid,
                    owner: .iphone,
                    title: "This device identity could not be verified",
                    message: "The gateway could not verify the identity this device presented.",
                    actionLabel: "Re-pair this device",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/pairing",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .deviceAuthPublicKeyInvalid:
            self.problem(
                .init(
                    kind: .devicePublicKeyInvalid,
                    owner: .iphone,
                    title: "This device identity could not be verified",
                    message: "The gateway could not verify the public key this device presented.",
                    actionLabel: "Re-pair this device",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/pairing",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        case .deviceAuthDeviceIdMismatch:
            self.problem(
                .init(
                    kind: .deviceIdMismatch,
                    owner: .iphone,
                    title: "This device identity could not be verified",
                    message: "The gateway rejected the device identity because the device ID did not match.",
                    actionLabel: "Re-pair this device",
                    actionCommand: nil,
                    docsURLString: "https://docs.openclaw.ai/gateway/pairing",
                    retryable: false,
                    pauseReconnect: true),
                authError: authError)
        default:
            // The dispatcher owns this category boundary; new identity failures must be routed there first.
            preconditionFailure("Unexpected device identity auth detail")
        }
    }
}

extension GatewayConnectionProblemMapper {
    private static func map(_ responseError: GatewayResponseError) -> GatewayConnectionProblem? {
        let code = responseError.code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if code == "NOT_PAIRED" || responseError.detailsReason == "not-paired" {
            let authError = GatewayConnectAuthError(
                message: responseError.message,
                detailCodeRaw: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
                canRetryWithDeviceToken: false,
                recommendedNextStepRaw: nil,
                requestId: self.stringValue(responseError.details["requestId"]?.value),
                detailsReason: responseError.detailsReason,
                ownerRaw: nil,
                titleOverride: nil,
                userMessageOverride: nil,
                actionLabel: nil,
                actionCommand: nil,
                docsURLString: nil,
                retryableOverride: nil,
                pauseReconnectOverride: nil)
            return self.map(authError)
        }
        return nil
    }

    private static func map(_ tlsError: GatewayTLSValidationError) -> GatewayConnectionProblem {
        let failure = tlsError.failure
        switch failure.kind {
        case .pinMismatch:
            let trustedSuffix = failure.systemTrustOk
                ? " The new certificate is trusted by this device; this is commonly caused by certificate rotation."
                : " This device could not verify the new certificate."
            let message = "The saved TLS certificate pin for \(failure.host) "
                + "no longer matches the gateway certificate.\(trustedSuffix)"
            // Keep the extraction keys contiguous for the native localization inventory.
            // swiftlint:disable line_length
            let messagePresentation: GatewayConnectionProblem.PresentationText = failure.systemTrustOk
                ? .localizedFormat(
                    "The saved TLS certificate pin for %@ no longer matches the gateway certificate. The new certificate is trusted by this device; this is commonly caused by certificate rotation.",
                    [failure.host])
                : .localizedFormat(
                    "The saved TLS certificate pin for %@ no longer matches the gateway certificate. This device could not verify the new certificate.",
                    [failure.host])
            // swiftlint:enable line_length
            return GatewayConnectionProblem(
                kind: .tlsPinMismatch,
                owner: failure.systemTrustOk ? .network : .unknown,
                title: "Gateway certificate changed",
                message: message,
                actionLabel: "Review certificate",
                messagePresentation: messagePresentation,
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: false,
                pauseReconnect: true,
                technicalDetails: tlsError.localizedDescription,
                tlsStoreKey: failure.storeKey,
                tlsExpectedFingerprint: failure.expectedFingerprint,
                tlsObservedFingerprint: failure.observedFingerprint,
                tlsSystemTrustOk: failure.systemTrustOk)
        case .certificateUnavailable:
            return GatewayConnectionProblem(
                kind: .tlsCertificateUnavailable,
                owner: .network,
                title: "Gateway certificate unavailable",
                message: "OpenClaw could not read the gateway certificate for \(failure.host).",
                actionLabel: "Retry",
                messagePresentation: .localizedFormat(
                    "OpenClaw could not read the gateway certificate for %@.",
                    [failure.host]),
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: true,
                pauseReconnect: false,
                technicalDetails: tlsError.localizedDescription)
        case .untrustedCertificate:
            return GatewayConnectionProblem(
                kind: .tlsCertificateUntrusted,
                owner: .network,
                title: "Gateway certificate is not trusted",
                message: "This device does not trust the TLS certificate presented by \(failure.host).",
                actionLabel: "Check certificate",
                messagePresentation: .localizedFormat(
                    "This device does not trust the TLS certificate presented by %@.",
                    [failure.host]),
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: false,
                pauseReconnect: true,
                technicalDetails: tlsError.localizedDescription)
        case .pinStorageUnavailable:
            return GatewayConnectionProblem(
                kind: .tlsCertificateUnavailable,
                owner: .unknown,
                title: "Gateway certificate unavailable",
                message: "OpenClaw could not securely save the TLS certificate pin for \(failure.host).",
                actionLabel: "Retry",
                titlePresentation: .localized("Gateway certificate unavailable"),
                messagePresentation: .localizedFormat(
                    "OpenClaw could not securely save the TLS certificate pin for %@.",
                    [failure.host]),
                actionLabelPresentation: .localized("Retry"),
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: true,
                pauseReconnect: false,
                technicalDetails: tlsError.localizedDescription)
        case .authorityMismatch:
            return GatewayConnectionProblem(
                kind: .tlsCertificateUntrusted,
                owner: .network,
                title: "Gateway certificate is not trusted",
                message: "The TLS challenge came from a different host or port than the requested Gateway.",
                actionLabel: "Check certificate",
                titlePresentation: .localized("Gateway certificate is not trusted"),
                messagePresentation: .localized(
                    "The TLS challenge came from a different host or port than the requested Gateway."),
                actionLabelPresentation: .localized("Check certificate"),
                actionCommand: nil,
                docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
                retryable: false,
                pauseReconnect: true,
                technicalDetails: tlsError.localizedDescription)
        }
    }

    private static func mapTransportError(_ error: Error) -> GatewayConnectionProblem? {
        let nsError = error as NSError
        let rawMessage = nsError.userInfo[NSLocalizedDescriptionKey] as? String ?? nsError.localizedDescription
        let message = rawMessage.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !message.isEmpty else { return nil }

        let typedKind = nsError.domain == URLError.errorDomain
            ? self.transportKind(for: URLError.Code(rawValue: nsError.code))
            : nil
        guard let kind = typedKind ?? self.transportKind(for: message) else { return nil }
        return self.transportProblem(kind: kind, technicalDetails: rawMessage)
    }

    private static func transportKind(for code: URLError.Code) -> GatewayConnectionProblem.Kind? {
        switch code {
        case .timedOut: .timeout
        case .cannotConnectToHost: .connectionRefused
        case .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet, .networkConnectionLost,
             .internationalRoamingOff, .callIsActive, .dataNotAllowed: .reachabilityFailed
        case .cancelled: .websocketCancelled
        default: nil
        }
    }

    private static func transportKind(for message: String) -> GatewayConnectionProblem.Kind? {
        if message.contains("timed out") { return .timeout }
        if message.contains("refused") { return .connectionRefused }
        let unreachable = ["cannot find host", "could not connect", "network is unreachable"]
        if unreachable.contains(where: message.contains) { return .reachabilityFailed }
        if message.contains("cancelled") || message.contains("canceled") { return .websocketCancelled }
        return nil
    }

    private static func transportProblem(
        kind: GatewayConnectionProblem.Kind,
        technicalDetails: String) -> GatewayConnectionProblem
    {
        let facts: (title: String, message: String, actionLabel: String) = switch kind {
        case .timeout:
            ("Connection timed out", "The gateway did not respond before the connection timed out.", "Retry")
        case .connectionRefused:
            (
                "Gateway refused the connection",
                "The gateway host was reachable, but it refused the connection.",
                "Retry")
        case .reachabilityFailed:
            (
                "Gateway is not reachable",
                "OpenClaw could not reach the gateway over the current network.",
                "Check network")
        case .websocketCancelled:
            ("Connection interrupted", "The connection to the gateway was interrupted before setup completed.", "Retry")
        default:
            preconditionFailure("Unexpected transport problem kind")
        }
        return GatewayConnectionProblem(
            kind: kind,
            owner: .network,
            title: facts.title,
            message: facts.message,
            actionLabel: facts.actionLabel,
            docsURL: URL(string: "https://docs.openclaw.ai/gateway/troubleshooting"),
            retryable: true,
            pauseReconnect: false,
            technicalDetails: technicalDetails)
    }

    private static func pairingProblem(for authError: GatewayConnectAuthError) -> GatewayConnectionProblem {
        let kind: GatewayConnectionProblem.Kind
        let title: String
        let message: String
        switch authError.detailsReason {
        case "role-upgrade":
            kind = .pairingRoleUpgradeRequired
            title = "Additional approval required"
            message = "This device is already paired, but it is requesting a new role "
                + "that was not previously approved."
        case "scope-upgrade":
            kind = .pairingScopeUpgradeRequired
            title = "Additional permissions required"
            message = "This device is already paired, but it is requesting new permissions that require approval."
        case "metadata-upgrade":
            kind = .pairingMetadataUpgradeRequired
            title = "Device approval needs refresh"
            message = "The gateway detected a change in this device's approved identity metadata "
                + "and requires re-approval."
        default:
            kind = .pairingRequired
            title = "This device is not approved yet"
            message = "The gateway received the connection request, but this device must be approved first."
        }
        return self.problem(
            .init(
                kind: kind,
                owner: .gateway,
                title: title,
                message: message,
                actionLabel: "Approve on gateway",
                actionCommand: self.approvalCommand(requestId: authError.requestId),
                docsURLString: "https://docs.openclaw.ai/gateway/pairing",
                retryable: false,
                pauseReconnect: true),
            authError: authError)
    }

    private static func protocolMismatchProblem(for authError: GatewayConnectAuthError) -> GatewayConnectionProblem {
        let title: String
        let message: String
        let owner: GatewayConnectionProblem.Owner
        let actionLabel: String
        let actionCommand: String?
        if let clientMax = authError.clientMaxProtocol,
           let expected = authError.expectedProtocol,
           clientMax < expected
        {
            title = "App update required"
            message = "This app is older than the gateway. Update OpenClaw on this device, then retry."
            owner = .iphone
            actionLabel = "Update app"
            actionCommand = nil
        } else if let clientMin = authError.clientMinProtocol,
                  let expected = authError.expectedProtocol,
                  clientMin > expected
        {
            title = "Gateway update required"
            message = "The gateway is older than this app. Update OpenClaw on the gateway host, then retry."
            owner = .gateway
            actionLabel = "Copy update command"
            actionCommand = "openclaw update"
        } else {
            title = "OpenClaw update required"
            message = "The app and gateway use incompatible protocol versions. Update OpenClaw on both, then retry."
            owner = .both
            actionLabel = "Update OpenClaw"
            actionCommand = nil
        }
        return self.problem(
            .init(
                kind: .protocolMismatch,
                owner: owner,
                title: title,
                message: message,
                actionLabel: actionLabel,
                actionCommand: actionCommand,
                docsURLString: "https://docs.openclaw.ai/gateway/troubleshooting",
                retryable: false,
                pauseReconnect: true),
            authError: authError)
    }

    private static func problem(
        _ defaults: AuthProblemDefaults,
        authError: GatewayConnectAuthError)
        -> GatewayConnectionProblem
    {
        let title = authError.titleOverride ?? defaults.title
        let message = authError.userMessageOverride ?? defaults.message
        let actionLabel = authError.actionLabel ?? defaults.actionLabel
        return GatewayConnectionProblem(
            kind: defaults.kind,
            owner: authError.ownerRaw.flatMap(self.owner(from:)) ?? defaults.owner,
            title: title,
            message: message,
            actionLabel: actionLabel,
            titlePresentation: authError.titleOverride == nil
                ? .localized(title)
                : .verbatim(title),
            messagePresentation: authError.userMessageOverride == nil
                && message != authError.message
                ? .localized(message)
                : .verbatim(message),
            actionLabelPresentation: authError.actionLabel == nil
                ? actionLabel.map(GatewayConnectionProblem.PresentationText.localized)
                : actionLabel.map(GatewayConnectionProblem.PresentationText.verbatim),
            actionCommand: authError.actionCommand ?? defaults.actionCommand,
            docsURL: self.docsURL(authError.docsURLString, fallback: defaults.docsURLString),
            requestId: authError.requestId,
            retryable: authError.retryableOverride ?? defaults.retryable,
            pauseReconnect: authError.pauseReconnectOverride ?? defaults.pauseReconnect,
            technicalDetails: self.technicalDetails(for: authError))
    }

    private static func approvalCommand(requestId: String?) -> String {
        self.nonEmpty(requestId).map { "openclaw devices approve \($0)" }
            ?? "openclaw devices list"
    }

    private static func technicalDetails(for authError: GatewayConnectAuthError) -> String? {
        var parts: [String?] = [
            self.nonEmpty(authError.detailCodeRaw),
            self.nonEmpty(authError.detailsReason).map { "reason=\($0)" },
            self.nonEmpty(authError.requestId).map { "requestId=\($0)" },
            self.nonEmpty(authError.recommendedNextStepRaw).map { "next=\($0)" },
            self.protocolRange(min: authError.clientMinProtocol, max: authError.clientMaxProtocol)
                .map { "clientProtocol=\($0)" },
            authError.expectedProtocol.map { "gatewayProtocol=\($0)" },
            authError.minimumProbeProtocol.map { "probeMin=\($0)" },
        ]
        if authError.canRetryWithDeviceToken { parts.insert("deviceTokenRetry=true", at: 4) }
        let details = parts.compactMap(\.self)
        return details.isEmpty ? nil : details.joined(separator: " · ")
    }

    private static func protocolRange(min: Int?, max: Int?) -> String? {
        switch (min, max) {
        case (nil, nil):
            nil
        case let (min?, max?) where min == max:
            "\(min)"
        case let (min?, max?):
            "\(min)-\(max)"
        case let (min?, nil):
            "min \(min)"
        case let (nil, max?):
            "max \(max)"
        }
    }

    private static func docsURL(_ preferred: String?, fallback: String?) -> URL? {
        self.nonEmpty(preferred).flatMap { URL(string: $0) }
            ?? self.nonEmpty(fallback).flatMap { URL(string: $0) }
    }

    private static func owner(from raw: String) -> GatewayConnectionProblem.Owner? {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "ios", "device": .iphone
        case "": .unknown
        case let normalized:
            GatewayConnectionProblem.Owner(rawValue: normalized)
        }
    }

    private static func stringValue(_ value: Any?) -> String? {
        self.nonEmpty(value as? String)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
