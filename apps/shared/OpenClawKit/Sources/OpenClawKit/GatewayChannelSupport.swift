import CryptoKit
import Foundation
import OpenClawProtocol

/// Transport facts from one admitted socket, not current settings or account authority.
public struct GatewayAdmittedHTTPContext: Sendable {
    public let gatewayURL: URL
    /// Nil means known unpinned policy; HTTPS consumers must still require system trust.
    public let tlsFingerprintSHA256: String?
    /// Sanitized credential headers actually supplied to this socket's upgrade.
    public let customHeaders: [String: String]
}

public enum GatewayRequestCompletionPolicy: Sendable {
    case requireCurrentRoute
    case preserveChatSendSuccess

    public func preservesSuccessfulResponse(for method: String) -> Bool {
        switch self {
        case .requireCurrentRoute: false
        case .preserveChatSendSuccess: method == "chat.send"
        }
    }
}

func gatewayIntValue(_ value: Any?) -> Int? {
    if let value = value as? Int {
        return value
    }
    if let value = value as? Int64 {
        return Int(exactly: value)
    }
    if let value = value as? Double, value.rounded() == value {
        return Int(exactly: value)
    }
    if let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() {
        let doubleValue = value.doubleValue
        guard doubleValue.rounded() == doubleValue else {
            return nil
        }
        return Int(exactly: doubleValue)
    }
    if let value = value as? String {
        return Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return nil
}

/// Bridges task cancellation into the request continuation without racing send.
final class GatewayRequestCancellationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    var isCancelled: Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.cancelled
    }

    func cancel() {
        self.lock.lock()
        self.cancelled = true
        self.lock.unlock()
    }
}

extension GatewayChannelActor {
    struct PendingRequest {
        let continuation: CheckedContinuation<GatewayFrame, Error>
        var timeoutTask: Task<Void, Never>?
        let transportLifetime = WebSocketRequestLifetime()
    }

    enum ConnectChallengeError: Error {
        case invalid
    }

    public static let defaultOperatorConnectScopes: [String] = [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.questions",
        "operator.pairing",
    ]

    struct SelectedConnectAuth {
        let authToken: String?
        let authBootstrapToken: String?
        let authDeviceToken: String?
        let authPassword: String?
        let signatureToken: String?
        let storedToken: String?
        let storedScopes: [String]?
        let authSource: GatewayAuthSource
        let suppressedDeviceTokenRetry: Bool
    }

    nonisolated static func _test_requestedScopesExceedStoredToken(
        role: String,
        requestedScopes: [String],
        storedToken: String?,
        storedScopes: [String]) -> Bool
    {
        self.requestedScopesExceedStoredToken(
            role: role,
            requestedScopes: requestedScopes,
            storedToken: storedToken,
            storedScopes: storedScopes)
    }

    nonisolated static func requestedScopesExceedStoredToken(
        role: String,
        requestedScopes: [String],
        storedToken: String?,
        storedScopes: [String]) -> Bool
    {
        storedToken != nil && !storedScopes.isEmpty &&
            !self.storedDeviceTokenScopesAllow(
                role: role,
                requestedScopes: requestedScopes,
                storedScopes: storedScopes)
    }

    private nonisolated static func storedDeviceTokenScopesAllow(
        role: String,
        requestedScopes: [String],
        storedScopes: [String]) -> Bool
    {
        let requested = self.normalizedScopeList(requestedScopes)
        if requested.isEmpty {
            return true
        }
        let allowed = self.normalizedScopeList(storedScopes)
        if allowed.isEmpty {
            return false
        }
        let allowedSet = Set(allowed)
        let normalizedRole = role.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedRole != "operator" {
            let prefix = "\(normalizedRole)."
            return requested.allSatisfy { scope in
                scope.hasPrefix(prefix) && allowedSet.contains(scope)
            }
        }
        return requested.allSatisfy { scope in
            self.operatorScopeSatisfied(scope, granted: allowedSet)
        }
    }

    private nonisolated static func normalizedScopeList(_ scopes: [String]) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        for scope in scopes {
            let trimmed = scope.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || seen.contains(trimmed) {
                continue
            }
            seen.insert(trimmed)
            out.append(trimmed)
        }
        return out
    }

    private nonisolated static func operatorScopeSatisfied(_ scope: String, granted: Set<String>) -> Bool {
        if !scope.hasPrefix("operator.") {
            return false
        }
        if granted.contains("operator.admin") {
            return true
        }
        if scope == "operator.read" {
            return granted.contains("operator.read") || granted.contains("operator.write")
        }
        if scope == "operator.write" {
            return granted.contains("operator.write")
        }
        return granted.contains(scope)
    }
}

extension GatewayChannelActor.SelectedConnectAuth {
    func httpResourceBearer(hello: HelloOk, role: String) -> String? {
        if (hello.auth["role"]?.stringValue ?? role) == role,
           let token = hello.auth["deviceToken"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty
        {
            return token
        }
        return switch self.authSource {
        case .deviceToken: self.authDeviceToken ?? self.authToken
        case .sharedToken: self.authToken
        case .password: self.authPassword
        case .bootstrapToken, .none: nil
        }
    }

    func makeAuthBinding(key: SymmetricKey?, deviceId: String?) -> GatewayAuthBinding {
        let credentialFingerprint = key.map { key in
            var values = [
                self.authSource.rawValue,
                deviceId ?? "",
            ]
            if let authToken = self.authToken {
                values.append(contentsOf: ["token", authToken])
                if let authDeviceToken = self.authDeviceToken {
                    values.append(contentsOf: ["deviceToken", authDeviceToken])
                }
            } else if let authBootstrapToken = self.authBootstrapToken {
                values.append(contentsOf: ["bootstrapToken", authBootstrapToken])
            } else if let authPassword = self.authPassword {
                values.append(contentsOf: ["password", authPassword])
            }
            let framed = values.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
            let tag = HMAC<SHA256>.authenticationCode(for: Data(framed.utf8), using: key)
            return tag.map { String(format: "%02x", $0) }.joined()
        }
        return GatewayAuthBinding(
            source: self.authSource,
            credentialFingerprint: credentialFingerprint)
    }
}
