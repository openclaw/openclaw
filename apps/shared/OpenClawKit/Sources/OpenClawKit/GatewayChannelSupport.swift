import CryptoKit
import Foundation
import OpenClawProtocol

func gatewayIntValue(_ value: Any?) -> Int? {
    if let value = value as? Int {
        return value
    }
    if let value = value as? Int64 {
        return Int(exactly: value)
    }
    if let value = value as? Double {
        return Int(exactly: value)
    }
    if let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() {
        return Int(exactly: value.doubleValue)
    }
    if let value = value as? String {
        return Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return nil
}

extension GatewayChannelActor {
    struct PendingRequest {
        let continuation: CheckedContinuation<ResponseFrame, Error>
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
            credentialFingerprint: credentialFingerprint,
            deviceId: deviceId)
    }
}
