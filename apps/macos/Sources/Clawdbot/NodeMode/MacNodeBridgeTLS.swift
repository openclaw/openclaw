import CryptoKit
import Foundation
import Network
import Security

struct MacNodeBridgeTLSParams: Sendable {
    let required: Bool
    let expectedFingerprint: String?
    let allowTOFU: Bool
    let storeKey: String?
}

enum MacNodeBridgeTLSStore {
    private static let suiteName = "com.clawdbot.shared"
    private static let keyPrefix = "mac.node.bridge.tls."

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

func makeMacNodeTLSOptions(_ params: MacNodeBridgeTLSParams?) -> NWProtocolTLS.Options? {
    guard let params else { return nil }
    let options = NWProtocolTLS.Options()
    let expected = params.expectedFingerprint.map(normalizeMacNodeFingerprint)
    let allowTOFU = params.allowTOFU
    let storeKey = params.storeKey

    sec_protocol_options_set_verify_block(
        options.securityProtocolOptions,
        { _, trust, complete in
            guard let trust else {
                complete(false)
                return
            }
            if let cert = SecTrustGetCertificateAtIndex(trust, 0) {
                let data = SecCertificateCopyData(cert) as Data
                let fingerprint = sha256Hex(data)
                if let expected {
                    complete(fingerprint == expected)
                    return
                }
                if allowTOFU {
                    if let storeKey { MacNodeBridgeTLSStore.saveFingerprint(fingerprint, stableID: storeKey) }
                    complete(true)
                    return
                }
            }
            let ok = SecTrustEvaluateWithError(trust, nil)
            complete(ok)
        },
        DispatchQueue(label: "com.clawdbot.macos.bridge.tls.verify"))

    return options
}

private func sha256Hex(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
}

private func normalizeMacNodeFingerprint(_ raw: String) -> String {
    raw.lowercased().filter(\.isHexDigit)
}
