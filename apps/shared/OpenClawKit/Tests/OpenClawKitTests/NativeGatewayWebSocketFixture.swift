#if os(macOS) || os(iOS)
import CryptoKit
import Foundation
import Network
import Security
@testable import OpenClawKit

@MainActor
final class NativeGatewayWebSocketFixture {
    struct ConnectAuth: Equatable, Sendable {
        let token: String?
        let bootstrapToken: String?
        let deviceToken: String?
    }

    struct ConnectFailure: Sendable {
        let message: String
        let detailCode: String
        let requestId: String

        static let pairingRequired = ConnectFailure(
            message: "pairing required",
            detailCode: GatewayConnectAuthDetailCode.pairingRequired.rawValue,
            requestId: "native-pairing-request")
    }

    struct Request: Sendable {
        let method: String
        let target: String
        let headers: [String: String]

        var isWebSocket: Bool {
            self.headers["upgrade"]?.lowercased() == "websocket"
        }
    }

    struct HTTPResponse: Sendable {
        var status = 200
        var headers: [String: String] = [:]
        var body = Data()
        var holdBody = false
        var holdHeaders = false
    }

    var httpResponse: ((Request) -> HTTPResponse)?
    private(set) var requests: [Request] = []
    private(set) var roles: [String] = []
    private var pendingHTTP: [Int: (Request, HTTPResponse)] = [:]

    private struct Client {
        enum Phase {
            case handshake
            case http
            case connect
            case open
        }

        let connection: NWConnection
        var buffer = Data()
        var phase = Phase.handshake
    }

    private static let websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    private let listener: NWListener
    private let issuedDeviceTokens: [String?]
    private let connectFailures: [Int: ConnectFailure]
    private var clients: [Int: Client] = [:]
    private var connectAuth: [ConnectAuth] = []
    private var nextConnectionIndex = 0
    private var stopped = false
    nonisolated let port: UInt16
    nonisolated let fingerprint: String?

    private init(
        listener: NWListener,
        port: UInt16,
        fingerprint: String?,
        issuedDeviceTokens: [String?],
        connectFailures: [Int: ConnectFailure])
    {
        self.listener = listener
        self.port = port
        self.fingerprint = fingerprint
        self.issuedDeviceTokens = issuedDeviceTokens
        self.connectFailures = connectFailures
        self.listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor [weak self] in
                guard let self else {
                    connection.cancel()
                    return
                }
                self.accept(connection)
            }
        }
    }

    /// Listener readiness must progress while other tests occupy MainActor.
    @concurrent
    nonisolated static func start(
        issuedDeviceTokens: [String?],
        connectFailures: [Int: ConnectFailure] = [:],
        tls: Bool = false) async throws -> NativeGatewayWebSocketFixture
    {
        let parameters: NWParameters
        let fingerprint: String?
        if tls {
            let certificateData = Data(base64Encoded: Self.certificateDER, options: .ignoreUnknownCharacters)!
            let keyData = Data(base64Encoded: Self.privateKeyDER, options: .ignoreUnknownCharacters)!
            guard let certificate = SecCertificateCreateWithData(nil, certificateData as CFData),
                  let key = SecKeyCreateWithData(
                      keyData as CFData,
                      [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPrivate] as CFDictionary,
                      nil),
                  let identity = SecIdentityCreate(nil, certificate, key),
                  let localIdentity = sec_identity_create(identity)
            else { throw URLError(.clientCertificateRejected) }
            let options = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(options.securityProtocolOptions, localIdentity)
            parameters = NWParameters(tls: options)
            fingerprint = SHA256.hash(data: certificateData).map { String(format: "%02x", $0) }.joined()
        } else {
            parameters = .tcp
            fingerprint = nil
        }
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters, on: .any)
        listener.newConnectionHandler = { $0.cancel() }
        listener.start(queue: DispatchQueue(label: "native-gateway-fixture-listener"))
        do {
            let deadline = ContinuousClock.now + .seconds(5)
            while true {
                try Task.checkCancellation()
                switch listener.state {
                case .ready:
                    guard let port = listener.port, port.rawValue != 0 else {
                        throw URLError(.cannotFindHost)
                    }
                    let fixture = await NativeGatewayWebSocketFixture(
                        listener: listener,
                        port: port.rawValue,
                        fingerprint: fingerprint,
                        issuedDeviceTokens: issuedDeviceTokens,
                        connectFailures: connectFailures)
                    try Task.checkCancellation()
                    return fixture
                case let .failed(error):
                    throw error
                case .cancelled:
                    throw CancellationError()
                default:
                    guard ContinuousClock.now < deadline else {
                        throw URLError(.timedOut, userInfo: [
                            NSLocalizedDescriptionKey: "Native gateway WebSocket fixture listener timed out: " +
                                "\(listener.state)",
                        ])
                    }
                    try await Task.sleep(for: .milliseconds(10))
                }
            }
        } catch {
            listener.cancel()
            throw error
        }
    }

    nonisolated func url() -> URL {
        URL(string: "\(self.fingerprint == nil ? "ws" : "wss")://127.0.0.1:\(self.port)")!
    }

    var activeConnectionCount: Int {
        self.clients.count
    }

    func capturedAuth(at index: Int) -> ConnectAuth? {
        guard self.connectAuth.indices.contains(index) else { return nil }
        return self.connectAuth[index]
    }

    func closeConnection(at index: Int) {
        self.close(index)
    }

    func stop() {
        guard !self.stopped else { return }
        self.stopped = true
        self.listener.cancel()
        for index in Array(self.clients.keys) {
            self.close(index)
        }
    }

    private func accept(_ connection: NWConnection) {
        guard !self.stopped else {
            connection.cancel()
            return
        }
        let index = self.nextConnectionIndex
        self.nextConnectionIndex += 1
        self.clients[index] = Client(connection: connection)
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                guard let self else {
                    connection.cancel()
                    return
                }
                switch state {
                case .ready:
                    self.receive(index)
                case .cancelled, .failed:
                    self.close(index)
                default:
                    break
                }
            }
        }
        connection.start(queue: .main)
    }

    private func receive(_ index: Int) {
        guard let client = self.clients[index] else { return }
        client.connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: 65536)
        { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, var client = self.clients[index] else { return }
                if let data {
                    client.buffer.append(data)
                    self.clients[index] = client
                    self.process(index)
                }
                if error != nil || complete {
                    self.close(index)
                } else if self.clients[index] != nil {
                    self.receive(index)
                }
            }
        }
    }

    private func process(_ index: Int) {
        guard let client = self.clients[index] else { return }
        switch client.phase {
        case .handshake:
            self.processHandshake(index)
        case .connect, .open:
            self.processFrames(index)
        case .http:
            break
        }
    }

    private func processHandshake(_ index: Int) {
        guard var client = self.clients[index],
              let headerEnd = client.buffer.range(of: Data("\r\n\r\n".utf8))
        else { return }
        let headerData = client.buffer[..<headerEnd.upperBound]
        client.buffer.removeSubrange(..<headerEnd.upperBound)
        guard let text = String(data: headerData, encoding: .utf8) else {
            self.close(index)
            return
        }
        let lines = text.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count >= 2 else { self.close(index)
            return
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1)
            if parts.count == 2 {
                headers[String(parts[0]).lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
            }
        }
        let request = Request(method: String(first[0]), target: String(first[1]), headers: headers)
        self.requests.append(request)
        if !request.isWebSocket {
            client.phase = .http
            self.clients[index] = client
            self.respondHTTP(request, index: index)
            return
        }
        guard let key = headers["sec-websocket-key"], !key.isEmpty else {
            self.close(index)
            return
        }

        let digest = Insecure.SHA1.hash(data: Data((key + Self.websocketGUID).utf8))
        let accept = Data(digest).base64EncodedString()
        let response = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Accept: \(accept)",
            "",
            "",
        ].joined(separator: "\r\n")
        client.phase = .connect
        self.clients[index] = client
        client.connection.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] error in
            MainActor.assumeIsolated {
                guard let self else { return }
                guard error == nil else {
                    self.close(index)
                    return
                }
                self.sendChallenge(index)
                self.processFrames(index)
            }
        })
    }

    func releaseHTTPResponses() {
        let pending = self.pendingHTTP
        self.pendingHTTP.removeAll()
        for (index, response) in pending {
            self.sendHTTP(response.1, request: response.0, index: index)
        }
    }

    private func respondHTTP(_ request: Request, index: Int) {
        let response = self.httpResponse?(request) ?? HTTPResponse(status: 404)
        if response.holdHeaders {
            // The verdict belongs to request arrival, even if credentials change before release.
            self.pendingHTTP[index] = (request, response)
            return
        }
        self.sendHTTP(response, request: request, index: index)
    }

    private func sendHTTP(_ response: HTTPResponse, request: Request, index: Int) {
        guard let client = self.clients[index] else { return }
        var headers = response.headers
        headers["Content-Length"] = String(response.body.count)
        headers["Connection"] = "close"
        let head = (["HTTP/1.1 \(response.status) Fixture"] +
            headers.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" } + ["", ""])
            .joined(separator: "\r\n")
        var data = Data(head.utf8)
        if request.method != "HEAD", !response.holdBody { data.append(response.body) }
        client.connection.send(content: data, completion: .contentProcessed { [weak self] error in
            MainActor.assumeIsolated {
                if error != nil || !response.holdBody { self?.close(index) }
            }
        })
    }

    private func processFrames(_ index: Int) {
        while var client = self.clients[index],
              let frame = Self.takeFrame(from: &client.buffer)
        {
            self.clients[index] = client
            switch frame.opcode {
            case 0x1, 0x2:
                self.handleText(frame.payload, index: index)
            case 0x8:
                self.close(index)
                return
            case 0x9:
                self.sendFrame(opcode: 0xA, payload: frame.payload, index: index)
            default:
                break
            }
        }
    }

    private func handleText(_ data: Data, index: Int) {
        guard var client = self.clients[index], client.phase == .connect,
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              request["type"] as? String == "req",
              request["method"] as? String == "connect",
              let id = request["id"] as? String
        else { return }

        let params = request["params"] as? [String: Any]
        let auth = params?["auth"] as? [String: Any]
        self.roles.append(params?["role"] as? String ?? "")
        self.connectAuth.append(ConnectAuth(
            token: auth?["token"] as? String,
            bootstrapToken: auth?["bootstrapToken"] as? String,
            deviceToken: auth?["deviceToken"] as? String))
        client.phase = .open
        self.clients[index] = client
        if let failure = self.connectFailures[index] {
            self.sendConnectFailure(id: id, failure: failure, index: index)
        } else {
            self.sendConnectOK(id: id, index: index)
        }
    }

    private func sendChallenge(_ index: Int) {
        let frame: [String: Any] = [
            "type": "event",
            "event": "connect.challenge",
            "payload": [
                "nonce": "native-transport-\(index)",
                "ts": 1_800_000_000_000,
            ],
        ]
        self.sendJSON(frame, index: index)
    }

    private func sendConnectOK(id: String, index: Int) {
        var auth: [String: Any] = [
            "role": "node",
            "scopes": [],
        ]
        if self.issuedDeviceTokens.indices.contains(index),
           let token = self.issuedDeviceTokens[index]
        {
            auth["deviceToken"] = token
        }
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": true,
            "payload": [
                "type": "hello-ok",
                "protocol": 2,
                "server": [
                    "version": "test",
                    "connId": "native-\(index)",
                ],
                "features": [
                    "methods": [],
                    "events": [],
                    "capabilities": [],
                ],
                "snapshot": [
                    "presence": [["ts": 1]],
                    "health": [:],
                    "stateVersion": [
                        "presence": 0,
                        "health": 0,
                    ],
                    "uptimeMs": 0,
                ],
                "policy": [
                    "maxPayload": 1,
                    "maxBufferedBytes": 1,
                    "tickIntervalMs": 30000,
                ],
                "auth": auth,
            ],
        ]
        self.sendJSON(frame, index: index)
    }

    private func sendConnectFailure(id: String, failure: ConnectFailure, index: Int) {
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": false,
            "error": [
                "code": "AUTH_UNAUTHORIZED",
                "message": failure.message,
                "details": [
                    "code": failure.detailCode,
                    "requestId": failure.requestId,
                ],
            ],
        ]
        self.sendJSON(frame, index: index)
    }

    private func sendJSON(_ frame: [String: Any], index: Int) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame) else {
            self.close(index)
            return
        }
        self.sendFrame(opcode: 0x1, payload: data, index: index)
    }

    private func sendFrame(opcode: UInt8, payload: Data, index: Int) {
        guard let client = self.clients[index] else { return }
        var frame = Data([0x80 | opcode])
        switch payload.count {
        case 0...125:
            frame.append(UInt8(payload.count))
        case 126...65535:
            frame.append(126)
            frame.append(UInt8((payload.count >> 8) & 0xFF))
            frame.append(UInt8(payload.count & 0xFF))
        default:
            self.close(index)
            return
        }
        frame.append(payload)
        client.connection.send(content: frame, completion: .contentProcessed { [weak self] error in
            guard error != nil else { return }
            MainActor.assumeIsolated {
                self?.close(index)
            }
        })
    }

    private func close(_ index: Int) {
        self.pendingHTTP.removeValue(forKey: index)
        self.clients.removeValue(forKey: index)?.connection.cancel()
    }

    private static func takeFrame(from buffer: inout Data) -> (opcode: UInt8, payload: Data)? {
        guard buffer.count >= 2 else { return nil }
        let first = buffer[buffer.startIndex]
        let second = buffer[buffer.index(after: buffer.startIndex)]
        var payloadLength = Int(second & 0x7F)
        var cursor = 2

        if payloadLength == 126 {
            guard buffer.count >= 4 else { return nil }
            payloadLength = Int(buffer[2]) << 8 | Int(buffer[3])
            cursor = 4
        } else if payloadLength == 127 {
            guard buffer.count >= 10 else { return nil }
            let length = buffer[2..<10].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            guard length <= UInt64(Int.max) else { return nil }
            payloadLength = Int(length)
            cursor = 10
        }

        let masked = second & 0x80 != 0
        let mask: [UInt8]
        if masked {
            guard buffer.count >= cursor + 4 else { return nil }
            mask = Array(buffer[cursor..<(cursor + 4)])
            cursor += 4
        } else {
            mask = []
        }
        guard buffer.count >= cursor + payloadLength else { return nil }

        var payload = Data(buffer[cursor..<(cursor + payloadLength)])
        if masked {
            for offset in payload.indices {
                payload[offset] ^= mask[(offset - payload.startIndex) % 4]
            }
        }
        buffer.removeSubrange(..<(cursor + payloadLength))
        return (first & 0x0F, payload)
    }

    /// Synthetic loopback-only identity. Tests pin its leaf certificate; it is never installed as trust.
    private nonisolated static let certificateDER = """
    MIIC2DCCAcCgAwIBAgIBATANBgkqhkiG9w0BAQsFADAkMSIwIAYDVQQDDBlPcGVuQ2xhdyBsb29wYmFjayBmaXh0dXJlMCAXDTIw
    MDEwMTAwMDAwMFoYDzIwNTAwMTAxMDAwMDAwWjAkMSIwIAYDVQQDDBlPcGVuQ2xhdyBsb29wYmFjayBmaXh0dXJlMIIBIjANBgkq
    hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwUOmv0sqisJscPhALYnxtc9H3IqOJM7LDzRGq9FgjoD5Cbj9dE344mqQ5ZQQ3Rt173tn
    nqKWd9CKOYSe4ywMAGsHs0FDg/Nzx4OkiMYJzx+egnf77h154FeS116Yoyrt5cmNgm63Blvca+1L4YgQ43LwmEVTKyP0junxq9JY
    2n9DUohmTVcBbaX8XToOMgaH4ahQv8520dAfperWAvLsWgPAMDT7/Q9ZZPgZXJ/tUKwdPKI8+RfeCOC9iOetpc9eS1phw5graFEo
    O+bIeEsSX5athV7yf9XwnTv+NFtGs/fdeHHJzhbC8CcZAlbzv1ftzN5ijcIxoQmZylGnMep/rwIDAQABoxMwETAPBgNVHREECDAG
    hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQAAgmUep9sC2UA7U7VjacQ8TBSNOqtA2Lwmi05V3YWfPt8G3Urq3VwNKvoFADLdfZoQ
    IMdK+NPklcGAPSeow5uwc95O4Or/SNso/zkNl/HSHRLhgQe0U5NMbBtVxsZi2UywcSBy/1rlmHxq+QT8EpqyXCmBkbNoHG0CHCqj
    sk56ZWBu8o386YUFbEfUEaTZ9n4yMSSULFNyGbcjlsWzx4wQpRxEzJ6kMfB53YaR+NTsCYNxV+AF8SDQvZ4EczrRGgco+n3Atzna
    40YUUj5vJhEoc2O+GGgNBWTeycPDVY60wUKb75/glJXLkNwJM/wEx43jhptQQMEKxFuPUlyozdz3
    """
    private nonisolated static let privateKeyDER = """
    MIIEowIBAAKCAQEAwUOmv0sqisJscPhALYnxtc9H3IqOJM7LDzRGq9FgjoD5Cbj9dE344mqQ5ZQQ3Rt173tnnqKWd9CKOYSe4ywM
    AGsHs0FDg/Nzx4OkiMYJzx+egnf77h154FeS116Yoyrt5cmNgm63Blvca+1L4YgQ43LwmEVTKyP0junxq9JY2n9DUohmTVcBbaX8
    XToOMgaH4ahQv8520dAfperWAvLsWgPAMDT7/Q9ZZPgZXJ/tUKwdPKI8+RfeCOC9iOetpc9eS1phw5graFEoO+bIeEsSX5athV7y
    f9XwnTv+NFtGs/fdeHHJzhbC8CcZAlbzv1ftzN5ijcIxoQmZylGnMep/rwIDAQABAoIBAB+2fCwzp11xnd3DvrQ6SIFu6/nSepSr
    okJyb45OIyv/Gd5wjpaBHO/6UKB7dXDyyp1rgItVXp92htf9XR0l4ypGZdMSSIPkdQEuJteSt5VXOOlrytk92PvpIt1YVm+f4b2t
    Hx1iEYJnnHnRTHxLmYnZGIXECmuv0LeKx+9L6uyfYGJM1e2JsTfNFC36TYcb1J040hTEgs2OZI6cZKqa2o1dtXpAals48I7fgv0N
    KbZoPnYIKmrUSqCeViuonIuN1qGI7rrVKK6YFmWOYed5/viKDFc4lagQQpJWzEz5lLQQmulySMJXFKFw0tqG9SH+3YXOP5UUSz7f
    T20oDWzm5RECgYEA5VG6mBlYZjCdqKbZ3f/N/6cPbEsrC9dCthwtMHLeEtiE3SiYP7QQVjHS/S0pkDrwBCqoilcusU3i8PRDxT2G
    17O5J+N4qYn9WV04SmtqYD6GJa8VnJsj/Qj68XrQkUxUX4ucTArc0C8/0KlESVX3hgjX+Barbam++6L/bYOtVQUCgYEA18AGaJgU
    iWWKryV8hzGqLyw7f2/EnMcCe6dU6+gr9eyEY7iU9ebvl46+zJFYZgu81spOn6jwtcdMq6JtuPvRcsD3QFsmhH4vH+kvVqHmZfzb
    SA6KKOLjTuGWitl9t/v1+iOOpHRvcGJpA2yAmw73AgG7uuUSSEtny7SX0UveYCMCgYAkY/PYby04Cj76pH+uWwm1qC0qYkNSfbZ4
    b8A8D/5tvy5Wajq+4TQ2eXGh+6i82p18C8jzKyKdwF5jHmAizMC5OiwHyHE9dkheBg0IwkL/QuzGziH/2B696M7pwzOV2ycIgn8r
    Eg44e0cFNddATAQboQuksvRBUs6b4CHonxzCgQKBgQDD328yCFgkwU5eYs8iwmE6gJLnyKYcm8TSVIGRx3AZzggHrO14Lph45Tyt
    5or14lQoQPWOmEcpEW63KDkrR1vJLg2LnPVkNlc8Rm0W3teY4i6GxcSDCDHMTJxrJLexkIup9BwtjBQcWQvz8s7zd2ujo8U3EX8+
    qU7rruJiPtn+NwKBgCHwFmtxBoq0wLKIbL3sBm4H0ZItLmR/+82UyI+ntKKA6ZMT8gRuPaHhW+QROxluhQdRMY2aHE8Iv4qngfvs
    /WUOQqa/2h2AV28IFimef/+F3aWmO6nHSDEkONZIBOMy/vcjrTQf5/A0mpwzwUxMrNg8uwW3gUyQtbOzbZ9129rl
    """
}
#endif
