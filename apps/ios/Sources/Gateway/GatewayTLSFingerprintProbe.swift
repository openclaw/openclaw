import CryptoKit
import Foundation
import Network
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
    if let serverName = url.host {
        return await GatewayNetworkTLSFingerprintProbe.probe(
            url: url,
            serverName: serverName,
            timeoutSeconds: GatewayTLSFingerprintProbeBudget.tlsHandshakeTimeoutSeconds)
    }
    return await withCheckedContinuation { continuation in
        let probe = GatewayTLSFingerprintProbe(
            url: url,
            timeoutSeconds: GatewayTLSFingerprintProbeBudget.tlsHandshakeTimeoutSeconds)
        { result in
            continuation.resume(returning: result)
        }
        probe.start()
    }
}

private final class GatewayTLSFingerprintProbe: NSObject, URLSessionDelegate, URLSessionTaskDelegate,
    @unchecked Sendable
{
    private struct ProbeState {
        var didFinish = false
        var session: URLSession?
        var task: URLSessionWebSocketTask?
    }

    private let url: URL
    private let timeoutSeconds: Double
    private let onComplete: (GatewayTLSFingerprintProbeResult) -> Void
    private let state = OSAllocatedUnfairLock(initialState: ProbeState())

    init(
        url: URL,
        timeoutSeconds: Double,
        onComplete: @escaping (GatewayTLSFingerprintProbeResult) -> Void)
    {
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
        let fp = GatewayTLSFingerprintProbe.certificateFingerprint(trust)
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
        typealias FinishState = (Bool, URLSessionWebSocketTask?, URLSession?)
        let (shouldComplete, taskToCancel, sessionToInvalidate) = self.state.withLock { s -> FinishState in
            guard !s.didFinish else { return (false, nil, nil) }
            s.didFinish = true
            let task = s.task
            let session = s.session
            s.task = nil
            s.session = nil
            return (true, task, session)
        }
        guard shouldComplete else { return }
        taskToCancel?.cancel(with: .goingAway, reason: nil)
        sessionToInvalidate?.invalidateAndCancel()
        self.onComplete(result)
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
        case .networkConnectionLost,
             .secureConnectionFailed,
             .cannotParseResponse,
             .badServerResponse:
            return .tlsUnavailable
        default:
            return .tlsUnavailable
        }
    }

    fileprivate static func certificateFingerprint(_ trust: SecTrust) -> String? {
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

private final class GatewayNetworkTLSFingerprintProbe: @unchecked Sendable {
    private struct State {
        var didFinish = false
        var connection: NWConnection?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    static func probe(
        url: URL,
        serverName: String,
        timeoutSeconds: Double) async -> GatewayTLSFingerprintProbeResult
    {
        let portValue = url.port ?? 443
        guard let host = url.host,
              (1...65535).contains(portValue),
              let port = NWEndpoint.Port(rawValue: UInt16(portValue))
        else { return .failure(.endpointUnreachable) }
        let probe = GatewayNetworkTLSFingerprintProbe()
        return await withCheckedContinuation { continuation in
            let tlsOptions = NWProtocolTLS.Options()
            let securityOptions = tlsOptions.securityProtocolOptions
            serverName.withCString {
                sec_protocol_options_set_tls_server_name(securityOptions, $0)
            }
            let verifyQueue = DispatchQueue(label: "ai.openclaw.gateway.tls-fingerprint-probe")
            sec_protocol_options_set_verify_block(
                securityOptions,
                { _, trust, complete in
                    let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
                    let systemTrusted = SecTrustEvaluateWithError(secTrust, nil)
                    let fp = GatewayTLSFingerprintProbe.certificateFingerprint(secTrust)
                    if systemTrusted, let fp {
                        probe.finish(.systemTrusted(fingerprint: fp), continuation: continuation)
                    } else if let fp {
                        probe.finish(.fingerprint(fp), continuation: continuation)
                    } else {
                        probe.finish(.failure(.certificateUnavailable), continuation: continuation)
                    }
                    complete(false)
                },
                verifyQueue)
            let connection = NWConnection(
                host: NWEndpoint.Host(host),
                port: port,
                using: NWParameters(tls: tlsOptions, tcp: NWProtocolTCP.Options()))
            probe.state.withLock { $0.connection = connection }
            connection.stateUpdateHandler = { state in
                switch state {
                case let .failed(error):
                    probe.finish(.failure(Self.failure(for: error)), continuation: continuation)
                case .cancelled:
                    probe.finish(.failure(.tlsUnavailable), continuation: continuation)
                default:
                    break
                }
            }
            connection.start(queue: DispatchQueue(label: "ai.openclaw.gateway.tls-fingerprint-probe.connection"))
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeoutSeconds) {
                probe.finish(.failure(.tlsHandshakeTimeout), continuation: continuation)
            }
        }
    }

    private func finish(
        _ result: GatewayTLSFingerprintProbeResult,
        continuation: CheckedContinuation<GatewayTLSFingerprintProbeResult, Never>)
    {
        let connection = self.state.withLock { state -> NWConnection? in
            guard !state.didFinish else { return nil }
            state.didFinish = true
            let connection = state.connection
            state.connection = nil
            return connection
        }
        guard let connection else { return }
        connection.cancel()
        continuation.resume(returning: result)
    }

    private static func failure(for error: NWError) -> GatewayTLSFingerprintProbeFailure {
        switch error {
        case .dns:
            return .endpointUnreachable
        case .posix:
            return .endpointUnreachable
        case .tls:
            return .tlsUnavailable
        case .wifiAware:
            return .endpointUnreachable
        @unknown default:
            return .tlsUnavailable
        }
    }
}
