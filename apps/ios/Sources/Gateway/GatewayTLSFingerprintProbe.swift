import Foundation
import OpenClawKit
import os
import Security

enum GatewayTLSFingerprintProbeFailure: Equatable {
    case endpointUnreachable
    case tlsHandshakeTimeout
    case tlsUnavailable
    case certificateUnavailable
}

enum GatewayTLSFingerprintProbeResult: Equatable {
    case systemTrusted(fingerprint: String)
    case fingerprint(String)
    case failure(GatewayTLSFingerprintProbeFailure)
}

typealias GatewayTLSFingerprintProbeFunction = @Sendable (URL) async -> GatewayTLSFingerprintProbeResult

enum GatewayTLSFingerprintProbeBudget {
    static let tcpConnectTimeoutSeconds = 3.0
    fileprivate static let tlsHandshakeTimeoutSeconds = 10.0
}

func defaultGatewayTLSFingerprintProbe(url: URL) async -> GatewayTLSFingerprintProbeResult {
    await withCheckedContinuation { continuation in
        let probe = GatewayTLSFingerprintProbe(
            url: url,
            timeoutSeconds: GatewayTLSFingerprintProbeBudget.tlsHandshakeTimeoutSeconds,
            continuation: continuation)
        probe.start()
    }
}

private final class GatewayTLSFingerprintProbe: NSObject, URLSessionDelegate, URLSessionTaskDelegate,
    @unchecked Sendable
{
    private struct ProbeState {
        var continuation: CheckedContinuation<GatewayTLSFingerprintProbeResult, Never>?
        var session: URLSession?
        var task: URLSessionWebSocketTask?
    }

    private let url: URL
    private let timeoutSeconds: Double
    private let state: OSAllocatedUnfairLock<ProbeState>

    init(
        url: URL,
        timeoutSeconds: Double,
        continuation: CheckedContinuation<GatewayTLSFingerprintProbeResult, Never>)
    {
        self.url = url
        self.timeoutSeconds = timeoutSeconds
        self.state = OSAllocatedUnfairLock(initialState: ProbeState(continuation: continuation))
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = self.timeoutSeconds
        config.timeoutIntervalForResource = self.timeoutSeconds
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: self.url)
        self.state.withLock { s in
            s.session = session
            s.task = task
        }
        task.resume()

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + self.timeoutSeconds) { [weak self] in
            self?.finish(.failure(.tlsHandshakeTimeout))
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

        let systemTrusted = SecTrustEvaluateWithError(trust, nil)
        let fp = GatewayTLSServerTrust.certificateFingerprint(trust)
        completionHandler(.cancelAuthenticationChallenge, nil)
        if systemTrusted, let fp {
            self.finish(.systemTrusted(fingerprint: fp))
        } else if let fp {
            self.finish(.fingerprint(fp))
        } else {
            self.finish(.failure(.certificateUnavailable))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else {
            self.finish(.failure(.tlsUnavailable))
            return
        }
        self.finish(.failure(Self.failure(for: error)))
    }

    private func finish(_ result: GatewayTLSFingerprintProbeResult) {
        let finished = self.state.withLock { state in
            defer { state = ProbeState() }
            return state
        }
        guard let continuation = finished.continuation else { return }
        finished.task?.cancel(with: .goingAway, reason: nil)
        finished.session?.invalidateAndCancel()
        continuation.resume(returning: result)
    }

    private static func failure(for error: Error) -> GatewayTLSFingerprintProbeFailure {
        let nsError = error as NSError
        guard nsError.domain == URLError.errorDomain else {
            return .tlsUnavailable
        }

        switch URLError.Code(rawValue: nsError.code) {
        case .timedOut:
            return .tlsHandshakeTimeout
        case .cannotFindHost,
             .dnsLookupFailed,
             .cannotConnectToHost,
             .notConnectedToInternet,
             .internationalRoamingOff,
             .callIsActive,
             .dataNotAllowed:
            return .endpointUnreachable
        default:
            return .tlsUnavailable
        }
    }
}
