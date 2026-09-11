#if os(macOS) || os(iOS)
import CryptoKit
import Foundation
import Network
import Security
import Testing
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

    struct HelloMetadata: Sendable {
        var role = "node"
        var scopes: [String] = []
        var capabilities: [String] = []
    }

    enum RPCResponse {
        case success([String: Any])
        case failure(code: String, message: String, details: [String: Any]? = nil)
    }

    typealias RPCHandler = @MainActor @Sendable ([String: Any]) -> RPCResponse

    private struct Client {
        enum Phase {
            case handshake
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
    private let hello: HelloMetadata
    private let rpcHandler: RPCHandler?
    private var clients: [Int: Client] = [:]
    private var connectAuth: [ConnectAuth] = []
    private var upgradeHeaders: [Int: String] = [:]
    private var nextConnectionIndex = 0
    private var stopped = false
    nonisolated let port: UInt16
    nonisolated let usesTLS: Bool

    private init(
        listener: NWListener,
        port: UInt16,
        issuedDeviceTokens: [String?],
        connectFailures: [Int: ConnectFailure],
        usesTLS: Bool,
        hello: HelloMetadata,
        rpcHandler: RPCHandler?)
    {
        self.listener = listener
        self.port = port
        self.issuedDeviceTokens = issuedDeviceTokens
        self.connectFailures = connectFailures
        self.usesTLS = usesTLS
        self.hello = hello
        self.rpcHandler = rpcHandler
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
        tlsIdentity: sec_identity_t? = nil,
        hello: HelloMetadata = .init(),
        rpcHandler: RPCHandler? = nil) async throws -> NativeGatewayWebSocketFixture
    {
        let parameters: NWParameters
        if let tlsIdentity {
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(tls.securityProtocolOptions, tlsIdentity)
            parameters = NWParameters(tls: tls)
        } else {
            parameters = .tcp
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
                        issuedDeviceTokens: issuedDeviceTokens,
                        connectFailures: connectFailures,
                        usesTLS: tlsIdentity != nil,
                        hello: hello,
                        rpcHandler: rpcHandler)
                    try Task.checkCancellation()
                    return fixture
                case let .failed(error):
                    throw error
                case .cancelled:
                    throw CancellationError()
                default:
                    guard ContinuousClock.now < deadline else {
                        throw URLError(.timedOut, userInfo: [
                            NSLocalizedDescriptionKey: "Native gateway WebSocket fixture listener timed out: \(listener.state)",
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
        URL(string: "\(self.usesTLS ? "wss" : "ws")://127.0.0.1:\(self.port)")!
    }

    var activeConnectionCount: Int {
        self.clients.count
    }

    func capturedAuth(at index: Int) -> ConnectAuth? {
        guard self.connectAuth.indices.contains(index) else { return nil }
        return self.connectAuth[index]
    }

    func capturedUpgradeHeader(_ name: String, at index: Int) -> String? {
        self.upgradeHeaders[index]?
            .components(separatedBy: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("\(name.lowercased()):") })?
            .split(separator: ":", maxSplits: 1).last?
            .trimmingCharacters(in: .whitespacesAndNewlines)
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
                    self.clients[index] = nil
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
        }
    }

    private func processHandshake(_ index: Int) {
        guard var client = self.clients[index],
              let headerEnd = client.buffer.range(of: Data("\r\n\r\n".utf8))
        else { return }
        let headerData = client.buffer[..<headerEnd.upperBound]
        client.buffer.removeSubrange(..<headerEnd.upperBound)
        guard let headers = String(data: headerData, encoding: .utf8),
              let key = headers
                  .components(separatedBy: "\r\n")
                  .first(where: { $0.lowercased().hasPrefix("sec-websocket-key:") })?
                  .split(separator: ":", maxSplits: 1)
                  .last?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
                  !key.isEmpty
        else {
            self.close(index)
            return
        }
        self.upgradeHeaders[index] = headers

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
        guard var client = self.clients[index],
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              request["type"] as? String == "req",
              let method = request["method"] as? String,
              let id = request["id"] as? String
        else { return }

        if client.phase == .open {
            // A rejected handshake must not reach the opt-in RPC handler.
            guard self.connectFailures[index] == nil, let rpcHandler = self.rpcHandler else { return }
            self.sendRPCResponse(rpcHandler(request), id: id, index: index)
            return
        }
        guard client.phase == .connect, method == "connect" else { return }

        let params = request["params"] as? [String: Any]
        let auth = params?["auth"] as? [String: Any]
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

    private func sendRPCResponse(_ response: RPCResponse, id: String, index: Int) {
        var frame: [String: Any] = ["type": "res", "id": id]
        switch response {
        case let .success(payload):
            frame["ok"] = true
            frame["payload"] = payload
        case let .failure(code, message, details):
            var error: [String: Any] = ["code": code, "message": message]
            if let details { error["details"] = details }
            frame["ok"] = false
            frame["error"] = error
        }
        self.sendJSON(frame, index: index)
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
            "role": self.hello.role,
            "scopes": self.hello.scopes,
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
                    "capabilities": self.hello.capabilities,
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
}

#if os(macOS)
/// The local listener's synthetic identity is imported in memory, never into Keychain.
struct NativeGatewayTLSIdentity {
    let identity: sec_identity_t
    let fingerprint: String

    init() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        func openssl(_ arguments: [String]) throws {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
            process.currentDirectoryURL = directory
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            try #require(process.terminationStatus == 0)
        }
        try openssl([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
            "-subj", "/CN=localhost", "-keyout", "key.pem", "-out", "cert.pem",
        ])
        try openssl([
            "pkcs12", "-export", "-inkey", "key.pem", "-in", "cert.pem", "-out", "identity.p12",
            "-passout", "pass:fixture", "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES",
            "-macalg", "sha1",
        ])
        let data = try Data(contentsOf: directory.appendingPathComponent("identity.p12"))
        var items: CFArray?
        let options: [String: Any] = [
            kSecImportExportPassphrase as String: "fixture",
            kSecImportToMemoryOnly as String: true,
        ]
        try #require(SecPKCS12Import(data as CFData, options as CFDictionary, &items) == errSecSuccess)
        let imported = try #require((items as? [[String: Any]])?.first?[kSecImportItemIdentity as String])
        // Security guarantees a SecIdentity at kSecImportItemIdentity.
        // swiftlint:disable:next force_cast
        let identity = imported as! SecIdentity
        self.identity = try #require(sec_identity_create(identity))
        var certificate: SecCertificate?
        try #require(SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess)
        let certificateData = try SecCertificateCopyData(#require(certificate)) as Data
        self.fingerprint = SHA256.hash(data: certificateData)
            .map { String(format: "%02x", $0) }.joined()
    }
}
#endif
#endif
