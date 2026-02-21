import CryptoKit
import Foundation
import Network
import Security

/// NWConnection-based WebSocket session that supports custom TLS verification.
///
/// URLSessionWebSocketTask on iOS 17/18 does not forward server trust challenges
/// to the delegate for self-signed certificates — the TLS handshake fails at the
/// Network.framework layer before the challenge reaches URLSession.
/// NWConnection exposes `sec_protocol_options_set_verify_block`, which lets us
/// perform the same TOFU / fingerprint-pinning logic directly in the TLS stack.
public final class NWWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    private let params: GatewayTLSParams

    public init(params: GatewayTLSParams) {
        self.params = params
    }

    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        WebSocketTaskBox(task: NWConnectionWebSocketTask(url: url, tlsParams: params))
    }
}

// MARK: -

final class NWConnectionWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let connection: NWConnection
    private let stateLock = NSLock()
    private var _state: URLSessionTask.State = .suspended

    var state: URLSessionTask.State {
        stateLock.withLock { _state }
    }

    init(url: URL, tlsParams: GatewayTLSParams?) {
        let parameters: NWParameters
        if url.scheme == "wss" {
            parameters = nwParametersWithCustomTLS(tlsParams: tlsParams)
        } else {
            parameters = .tcp
        }

        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        wsOptions.maximumMessageSize = 16 * 1024 * 1024
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        // Use NWEndpoint.url so NWProtocolWebSocket can construct the HTTP upgrade request
        // (Host header, path). Using host/port directly causes "unable to create url endpoint".
        connection = NWConnection(to: .url(url), using: parameters)
    }

    // MARK: TLS verification

    static func verifyTrust(
        _ trust: sec_trust_t,
        params: GatewayTLSParams?,
        complete: @escaping sec_protocol_verify_complete_t
    ) {
        guard let params else { complete(true); return }

        let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
        guard let chain = SecTrustCopyCertificateChain(secTrust) as? [SecCertificate],
              let cert = chain.first
        else { complete(!params.required); return }

        let fp = sha256Hex(SecCertificateCopyData(cert) as Data)

        if let expected = params.expectedFingerprint.map(normalizeFingerprint) {
            complete(fp == expected)
            return
        }

        if params.allowTOFU {
            if let key = params.storeKey {
                GatewayTLSStore.saveFingerprint(fp, stableID: key)
            }
            complete(true)
            return
        }

        var cfErr: CFError?
        complete(SecTrustEvaluateWithError(secTrust, &cfErr) || !params.required)
    }

    // MARK: WebSocketTasking

    func resume() {
        stateLock.withLock { _state = .running }
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .cancelled, .failed:
                self.stateLock.withLock { self._state = .completed }
            default:
                break
            }
        }
        connection.start(queue: .global(qos: .default))
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        stateLock.withLock { _state = .canceling }
        connection.cancel()
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let data: Data?
            let opcode: NWProtocolWebSocket.Opcode
            switch message {
            case .string(let s):
                data = s.data(using: .utf8)
                opcode = .text
            case .data(let d):
                data = d
                opcode = .binary
            @unknown default:
                cont.resume(throwing: NSError(
                    domain: "WebSocket", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "unsupported message type"]))
                return
            }
            let meta = NWProtocolWebSocket.Metadata(opcode: opcode)
            let ctx = NWConnection.ContentContext(identifier: "ws-send", metadata: [meta])
            connection.send(
                content: data, contentContext: ctx, isComplete: true,
                completion: .contentProcessed { error in
                    if let error { cont.resume(throwing: error) }
                    else { cont.resume(returning: ()) }
                })
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { cont in
            self.receiveLoop { result in
                switch result {
                case .success(let m): cont.resume(returning: m)
                case .failure(let e): cont.resume(throwing: e)
                }
            }
        }
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    ) {
        receiveLoop(completion: completionHandler)
    }

    // MARK: Private

    private func receiveLoop(
        completion: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    ) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if let error { completion(.failure(error)); return }
            guard let meta = context?.protocolMetadata.first as? NWProtocolWebSocket.Metadata else {
                self.receiveLoop(completion: completion)
                return
            }
            switch meta.opcode {
            case .text:
                let str = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                completion(.success(.string(str)))
            case .binary:
                completion(.success(.data(data ?? Data())))
            case .close:
                completion(.failure(NSError(
                    domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost,
                    userInfo: [NSLocalizedDescriptionKey: "WebSocket closed by server"])))
            default:
                self.receiveLoop(completion: completion) // ping/pong: autoReplyPing handles, loop
            }
        }
    }
}

// MARK: - NW TLS parameter builder (module-internal)

func nwParametersWithCustomTLS(tlsParams: GatewayTLSParams?) -> NWParameters {
    let tlsOptions = NWProtocolTLS.Options()
    let captured = tlsParams
    sec_protocol_options_set_verify_block(
        tlsOptions.securityProtocolOptions,
        { _, trust, complete in
            NWConnectionWebSocketTask.verifyTrust(trust, params: captured, complete: complete)
        },
        .global()
    )
    return NWParameters(tls: tlsOptions)
}

// MARK: - NWStreamingHTTPPost

/// NWConnection-based streaming HTTPS POST.
///
/// URLSession on iOS 17/18 does not forward server trust challenges to the delegate
/// for self-signed certificates. This class uses NWConnection with a custom
/// `sec_protocol_verify_block` so the same fingerprint-pinning logic applies.
public final class NWStreamingHTTPPost: @unchecked Sendable {
    private let url: URL
    private let tlsParams: GatewayTLSParams?

    public init(url: URL, tlsParams: GatewayTLSParams?) {
        self.url = url
        self.tlsParams = tlsParams
    }

    public func post(
        headers: [(String, String)],
        body: Data
    ) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let scheme = self.url.scheme ?? "https"
            let host = self.url.host ?? "localhost"
            let portNum = UInt16(self.url.port ?? (scheme == "https" ? 443 : 80))
            let port = NWEndpoint.Port(rawValue: portNum) ?? .https
            let path: String = {
                var p = self.url.path
                if p.isEmpty { p = "/" }
                if let q = self.url.query { p += "?" + q }
                return p
            }()

            let parameters: NWParameters = scheme == "https"
                ? nwParametersWithCustomTLS(tlsParams: self.tlsParams)
                : .tcp

            let connection = NWConnection(host: .init(host), port: port, using: parameters)
            let state = NWHTTPState()

            connection.stateUpdateHandler = { nwState in
                switch nwState {
                case .ready:
                    var req = "POST \(path) HTTP/1.1\r\nHost: \(host)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n"
                    for (name, value) in headers { req += "\(name): \(value)\r\n" }
                    req += "\r\n"
                    var requestData = Data(req.utf8)
                    requestData.append(body)
                    connection.send(content: requestData, completion: .contentProcessed { error in
                        if let error { continuation.finish(throwing: error); connection.cancel() }
                    })
                    nwReceive(connection: connection, state: state, continuation: continuation)
                case .failed(let error):
                    continuation.finish(throwing: error)
                case .cancelled:
                    continuation.finish()
                default:
                    break
                }
            }

            connection.start(queue: .global(qos: .userInitiated))
            continuation.onTermination = { _ in connection.cancel() }
        }
    }
}

// MARK: - NW HTTP parsing (file-private)

private final class NWHTTPState: @unchecked Sendable {
    var buffer = Data()
    var headersParsed = false
    var isChunked = false
    var statusCode = 0
}

private func nwReceive(
    connection: NWConnection,
    state: NWHTTPState,
    continuation: AsyncThrowingStream<Data, Error>.Continuation
) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
        if let error { continuation.finish(throwing: error); return }
        if let data, !data.isEmpty { state.buffer.append(data) }
        nwProcess(connection: connection, state: state, continuation: continuation, isComplete: isComplete)
    }
}

private func nwProcess(
    connection: NWConnection,
    state: NWHTTPState,
    continuation: AsyncThrowingStream<Data, Error>.Continuation,
    isComplete: Bool
) {
    if !state.headersParsed {
        let sep = Data("\r\n\r\n".utf8)
        guard let sepRange = state.buffer.range(of: sep) else {
            if isComplete {
                continuation.finish(throwing: NSError(
                    domain: "NWHTTPPost", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "connection closed before response headers"]))
            } else {
                nwReceive(connection: connection, state: state, continuation: continuation)
            }
            return
        }
        let headerData = Data(state.buffer[state.buffer.startIndex..<sepRange.lowerBound])
        state.buffer = Data(state.buffer[sepRange.upperBound...])
        state.headersParsed = true

        if let headerStr = String(data: headerData, encoding: .utf8) {
            let lines = headerStr.components(separatedBy: "\r\n")
            let statusParts = (lines.first ?? "").split(separator: " ", maxSplits: 2)
            state.statusCode = statusParts.count >= 2 ? Int(statusParts[1]) ?? 0 : 0
            state.isChunked = lines.contains {
                $0.lowercased().hasPrefix("transfer-encoding:") && $0.lowercased().contains("chunked")
            }
        }

        if state.statusCode >= 400 {
            nwCollectError(connection: connection, state: state, continuation: continuation, isComplete: isComplete)
            return
        }
    }

    nwProcessBody(connection: connection, state: state, continuation: continuation, isComplete: isComplete)
}

private func nwProcessBody(
    connection: NWConnection,
    state: NWHTTPState,
    continuation: AsyncThrowingStream<Data, Error>.Continuation,
    isComplete: Bool
) {
    if state.isChunked {
        if nwParseChunks(&state.buffer, continuation: continuation) {
            return // terminal chunk seen; continuation.finish() already called
        }
    } else if !state.buffer.isEmpty {
        continuation.yield(state.buffer)
        state.buffer = Data()
    }
    if isComplete {
        continuation.finish()
    } else {
        nwReceive(connection: connection, state: state, continuation: continuation)
    }
}

private func nwCollectError(
    connection: NWConnection,
    state: NWHTTPState,
    continuation: AsyncThrowingStream<Data, Error>.Continuation,
    isComplete: Bool
) {
    if isComplete || state.buffer.count >= 4096 {
        let msg = String(data: state.buffer.prefix(4096), encoding: .utf8) ?? "HTTP error"
        continuation.finish(throwing: NSError(
            domain: "NWHTTPPost", code: state.statusCode,
            userInfo: [NSLocalizedDescriptionKey: "HTTP \(state.statusCode): \(msg)"]))
        return
    }
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, complete, _ in
        if let data { state.buffer.append(data) }
        nwCollectError(connection: connection, state: state, continuation: continuation, isComplete: complete)
    }
}

// Returns true if the terminal chunk (size 0) was found and continuation.finish() was called.
private func nwParseChunks(
    _ buffer: inout Data,
    continuation: AsyncThrowingStream<Data, Error>.Continuation
) -> Bool {
    while buffer.count >= 3 {
        // Find \r\n terminating the chunk-size line.
        guard let cr = (0..<(buffer.count - 1)).first(where: { buffer[$0] == 0x0D && buffer[$0 + 1] == 0x0A }),
              let sizeStr = String(data: buffer[0..<cr], encoding: .utf8),
              let chunkSize = Int(sizeStr.trimmingCharacters(in: .whitespaces), radix: 16)
        else { break }

        if chunkSize == 0 { continuation.finish(); return true }

        let dataStart = cr + 2
        let nextStart = dataStart + chunkSize + 2 // skip trailing \r\n
        guard buffer.count >= nextStart else { break }

        continuation.yield(Data(buffer[dataStart..<(dataStart + chunkSize)]))
        buffer = Data(buffer[nextStart...])
    }
    return false
}
