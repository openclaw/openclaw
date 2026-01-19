import CryptoKit
import Foundation
import Security

struct GatewayTLSParams: Sendable {
    let required: Bool
    let expectedFingerprint: String?
    let allowTOFU: Bool
    let storeKey: String?
}

enum GatewayTLSStore {
    private static let suiteName = "com.clawdbot.shared"
    private static let keyPrefix = "gateway.tls."

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    static func loadFingerprint(stableID: String) -> String? {
        let key = self.keyPrefix + stableID
        let raw = self.defaults.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw?.isEmpty == false ? raw : nil
    }

    static func saveFingerprint(_ value: String, stableID: String) {
        let key = self.keyPrefix + stableID
        self.defaults.set(value, forKey: key)
    }
}

final class GatewayTLSPinningSession: NSObject, WebSocketSessioning, URLSessionDelegate {
    private let params: GatewayTLSParams
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    init(params: GatewayTLSParams) {
        self.params = params
        super.init()
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        let task = self.session.webSocketTask(with: url)
        task.maximumMessageSize = 16 * 1024 * 1024
        return WebSocketTaskBox(task: task)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let expected = params.expectedFingerprint.map(normalizeFingerprint)
        if let fingerprint = certificateFingerprint(trust) {
            if let expected {
                if fingerprint == expected {
                    completionHandler(.useCredential, URLCredential(trust: trust))
                } else {
                    completionHandler(.cancelAuthenticationChallenge, nil)
                }
                return
            }
            if params.allowTOFU {
                if let storeKey = params.storeKey {
                    GatewayTLSStore.saveFingerprint(fingerprint, stableID: storeKey)
                }
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }
        }

        let ok = SecTrustEvaluateWithError(trust, nil)
        if ok || !params.required {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

private func certificateFingerprint(_ trust: SecTrust) -> String? {
    let count = SecTrustGetCertificateCount(trust)
    guard count > 0, let cert = SecTrustGetCertificateAtIndex(trust, 0) else { return nil }
    let data = SecCertificateCopyData(cert) as Data
    return sha256Hex(data)
}

private func sha256Hex(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
}

private func normalizeFingerprint(_ raw: String) -> String {
    raw.lowercased().filter(\.isHexDigit)
}
