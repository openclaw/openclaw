import CryptoKit
import Foundation
import OpenClawKit
import Security

enum GatewayTLSPinningSupport {
    static func storeKey(host: String, port: Int) -> String? {
        guard let canonicalHost = self.canonicalHost(host), port > 0 else { return nil }
        return "\(canonicalHost):\(port)"
    }

    private static func canonicalHost(_ host: String) -> String? {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutTrailingDot = trimmedHost.hasSuffix(".") ? String(trimmedHost.dropLast()) : trimmedHost
        let normalizedHost = withoutTrailingDot.lowercased()
        guard !normalizedHost.isEmpty else { return nil }
        return normalizedHost
    }

    static func storeKey(url: URL) -> String? {
        guard url.scheme?.lowercased() == "wss",
              let host = url.host,
              let key = self.storeKey(host: host, port: url.port ?? 443)
        else {
            return nil
        }
        return key
    }

    static func pinnedSessionBox(url: URL) -> WebSocketSessionBox? {
        guard let storeKey = self.storeKey(url: url),
              let fingerprint = self.pinnedFingerprint(url: url)
        else {
            return nil
        }
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: fingerprint,
            allowTOFU: false,
            storeKey: storeKey)
        return WebSocketSessionBox(session: GatewayTLSPinningSession(params: params))
    }

    static func pinnedFingerprint(url: URL) -> String? {
        guard let storeKey = self.storeKey(url: url) else {
            return nil
        }
        return GatewayTLSStore.loadFingerprint(stableID: storeKey)
    }
}

final class GatewayTLSFingerprintProbe: NSObject, URLSessionDelegate, @unchecked Sendable {
    private struct ProbeState {
        var didFinish = false
        var session: URLSession?
        var task: URLSessionWebSocketTask?
    }

    private let url: URL
    private let timeoutSeconds: Double
    private let onComplete: (String?) -> Void
    private let state = OSAllocatedUnfairLock(initialState: ProbeState())

    init(url: URL, timeoutSeconds: Double, onComplete: @escaping (String?) -> Void) {
        self.url = url
        self.timeoutSeconds = timeoutSeconds
        self.onComplete = onComplete
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = self.timeoutSeconds
        config.timeoutIntervalForResource = self.timeoutSeconds
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: self.url)
        self.state.withLock { state in
            state.session = session
            state.task = task
        }
        task.resume()

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + self.timeoutSeconds) { [weak self] in
            self?.finish(nil)
        }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let fingerprint = Self.certificateFingerprint(trust)
        completionHandler(.cancelAuthenticationChallenge, nil)
        self.finish(fingerprint)
    }

    private func finish(_ fingerprint: String?) {
        let (shouldComplete, taskToCancel, sessionToInvalidate) = self.state.withLock { state ->
            (Bool, URLSessionWebSocketTask?, URLSession?) in
            guard !state.didFinish else { return (false, nil, nil) }
            state.didFinish = true
            let task = state.task
            let session = state.session
            state.task = nil
            state.session = nil
            return (true, task, session)
        }
        guard shouldComplete else { return }
        taskToCancel?.cancel(with: .goingAway, reason: nil)
        sessionToInvalidate?.invalidateAndCancel()
        self.onComplete(fingerprint)
    }

    private static func certificateFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let cert = chain.first
        else {
            return nil
        }
        let data = SecCertificateCopyData(cert) as Data
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
