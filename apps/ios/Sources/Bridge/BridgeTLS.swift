import CryptoKit
import Foundation
import Network
import Security

struct BridgeTLSParams: Sendable {
    let required: Bool
    let expectedFingerprint: String?
    let allowTOFU: Bool
    let storeKey: String?
}

enum BridgeTLSStore {
    private static let service = "com.clawdbot.bridge.tls"

    static func loadFingerprint(stableID: String) -> String? {
        KeychainStore.loadString(service: service, account: stableID)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func saveFingerprint(_ value: String, stableID: String) {
        _ = KeychainStore.saveString(value, service: service, account: stableID)
    }
}

func makeBridgeTLSOptions(_ params: BridgeTLSParams?) -> NWProtocolTLS.Options? {
    guard let params else { return nil }
    let options = NWProtocolTLS.Options()
    let expected = params.expectedFingerprint.map(normalizeBridgeFingerprint)
    let allowTOFU = params.allowTOFU
    let storeKey = params.storeKey

    sec_protocol_options_set_verify_block(
        options.securityProtocolOptions,
        { _, trust, complete in
            let trustRef = sec_trust_copy_ref(trust).takeRetainedValue()
            if let chain = SecTrustCopyCertificateChain(trustRef) as? [SecCertificate],
               let cert = chain.first
            {
                let data = SecCertificateCopyData(cert) as Data
                let fingerprint = sha256Hex(data)
                if let expected {
                    complete(fingerprint == expected)
                    return
                }
                if allowTOFU {
                    if let storeKey { BridgeTLSStore.saveFingerprint(fingerprint, stableID: storeKey) }
                    complete(true)
                    return
                }
            }
            let ok = SecTrustEvaluateWithError(trustRef, nil)
            complete(ok)
        },
        DispatchQueue(label: "com.clawdbot.bridge.tls.verify"))

    return options
}

private func sha256Hex(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
}

private func normalizeBridgeFingerprint(_ raw: String) -> String {
    raw.lowercased().filter { $0.isHexDigit }
}
