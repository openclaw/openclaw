import CryptoKit
import Foundation
import Network
import Security
@testable import OpenClawKit

/// Watch simulator tests use URLSession's supported HTTPS path, not custom URLProtocol subclasses.
/// The listener is test-only: TN3135 does not permit this listener in an ordinary physical Watch app.
@MainActor
final class WatchGatewayOperatorHTTPFixture {
    let session: GatewayOperatorHTTPSession
    let identity: DeviceIdentity
    private let server: WatchGatewayOperatorHTTPServer
    private var stopping: Task<Void, Never>?

    private init(server: WatchGatewayOperatorHTTPServer, identity: DeviceIdentity, gatewayID: String) throws {
        self.server = server
        self.identity = identity
        let fingerprint = server.fingerprint
        self.session = try GatewayOperatorHTTPSession(
            endpoint: server.endpoint, gatewayID: gatewayID, makeHTTP: {
                GatewayTLSPinningSession(
                    params: .init(
                        required: true, expectedFingerprint: fingerprint, allowTOFU: false, storeKey: nil),
                    allowsRedirects: false,
                    allowsStoredCredentials: false)
            })
    }

    static func start(
        gatewayID: String,
        scopes: [String] = GatewayOperatorHTTPFixture.scopes,
        identityData: Data? = nil) async throws -> WatchGatewayOperatorHTTPFixture
    {
        let bytes: Data
        if let identityData {
            bytes = identityData
        } else {
            guard let url = Bundle(for: Self.self).url(
                forResource: "GatewayOperatorHTTPFixture", withExtension: "p12")
            else { throw Self.failure("Missing generated Watch TLS fixture identity") }
            bytes = try Data(contentsOf: url)
        }
        let server = try WatchGatewayOperatorHTTPServer(identityData: bytes)
        do {
            try await server.start()
            guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary),
                  DeviceAuthStore.storeTokenPersisted(
                      deviceId: identity.deviceId,
                      role: "operator",
                      token: GatewayOperatorHTTPFixture.token,
                      scopes: scopes,
                      gatewayID: gatewayID,
                      profile: .primary)
            else { throw Self.failure("Could not persist the Watch fixture operator grant") }
            return try Self(server: server, identity: identity, gatewayID: gatewayID)
        } catch {
            await server.stop()
            throw error
        }
    }

    var snapshot: [GatewayOperatorHTTPExchange] {
        self.server.snapshot
    }

    var completedResponses: [Int] {
        self.server.completedResponses
    }

    func next(_ stage: String) async throws -> GatewayOperatorHTTPExchange {
        let requests = self.server.requests
        do {
            return try await AsyncTimeout.withTimeout(
                seconds: 3,
                onTimeout: {
                    URLError(.timedOut, userInfo: [
                        NSLocalizedDescriptionKey: "Watch operator fixture timed out waiting for \(stage)",
                    ])
                },
                operation: {
                    var iterator = requests.makeAsyncIterator()
                    guard let exchange = try await iterator.next() else { throw CancellationError() }
                    return exchange
                })
        } catch {
            throw NSError(
                domain: "WatchGatewayOperatorHTTPFixture",
                code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "\(stage): \(error.localizedDescription); received=\(self.snapshot.count), " +
                        "completed=\(self.completedResponses.count)",
                    NSUnderlyingErrorKey: error,
                ])
        }
    }

    func stop() async {
        if let stopping {
            await stopping.value
            return
        }
        let stopping = Task {
            await self.session.disconnect()
            await self.server.stop()
        }
        self.stopping = stopping
        await stopping.value
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "WatchGatewayOperatorHTTPFixture", code: 1, userInfo: [
            NSLocalizedDescriptionKey: message,
        ])
    }
}

/// Queue-owned TLS listener, following GatewayTLSHTTPFixture's in-memory identity and loopback ownership.
private final class WatchGatewayOperatorHTTPServer: @unchecked Sendable {
    private struct Client {
        let connection: NWConnection
        var buffer = Data()
        var delivered = false
        var responding = false
    }

    private static let maximumHeaderBytes = 16 * 1024
    private static let maximumBodyBytes = 2 * 1024 * 1024
    private let queue = DispatchQueue(label: "watch-operator-http-fixture")
    // Retain the imported identity until the listener and all accepted connections have joined.
    private let tlsIdentity: sec_identity_t
    private let listener: NWListener
    private let requestContinuation: AsyncThrowingStream<GatewayOperatorHTTPExchange, any Error>.Continuation
    private let ready = AsyncThrowingStream<UInt16, any Error>.makeStream()
    private var clients: [UUID: Client] = [:]
    private var recorded: [GatewayOperatorHTTPExchange] = []
    private var responseStatuses: [Int] = []
    private var stopped = false
    private var listenerStopped = false
    private var stopWaiters: [CheckedContinuation<Void, Never>] = []
    private var port: UInt16 = 0
    let requests: AsyncThrowingStream<GatewayOperatorHTTPExchange, any Error>
    let fingerprint: String

    init(identityData: Data) throws {
        let identity = try Self.importIdentity(identityData)
        self.tlsIdentity = identity.value
        self.fingerprint = identity.fingerprint
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, self.tlsIdentity)
        let parameters = NWParameters(tls: tls)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        self.listener = try NWListener(using: parameters, on: .any)
        let requests = AsyncThrowingStream<GatewayOperatorHTTPExchange, any Error>.makeStream()
        self.requests = requests.stream
        self.requestContinuation = requests.continuation
        self.listener.newConnectionHandler = { [weak self] connection in
            guard let self else {
                connection.cancel()
                return
            }
            self.accept(connection)
        }
        self.listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                if let port = self.listener.port {
                    self.port = port.rawValue
                    self.ready.continuation.yield(port.rawValue)
                    self.ready.continuation.finish()
                }
            case let .failed(error):
                self.ready.continuation.finish(throwing: error)
                self.requestContinuation.finish(throwing: error)
                self.listener.cancel()
            case .cancelled:
                self.listenerStopped = true
                self.ready.continuation.finish(throwing: CancellationError())
                self.finishStop()
            default:
                break
            }
        }
    }

    var endpoint: URL {
        self.queue.sync { URL(string: "https://localhost:\(self.port)/team")! }
    }

    var snapshot: [GatewayOperatorHTTPExchange] {
        self.queue.sync { self.recorded }
    }

    var completedResponses: [Int] {
        self.queue.sync { self.responseStatuses }
    }

    func start() async throws {
        self.listener.start(queue: self.queue)
        let states = self.ready.stream
        _ = try await AsyncTimeout.withTimeout(
            seconds: 5,
            onTimeout: {
                URLError(.timedOut, userInfo: [
                    NSLocalizedDescriptionKey: "Watch TLS fixture listener did not become ready",
                ])
            },
            operation: {
                var iterator = states.makeAsyncIterator()
                guard let port = try await iterator.next() else { throw CancellationError() }
                return port
            })
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            self.queue.async {
                self.stopWaiters.append(continuation)
                self.stopped = true
                self.requestContinuation.finish(throwing: CancellationError())
                self.listener.cancel()
                for client in self.clients.values {
                    client.connection.cancel()
                }
                self.finishStop()
            }
        }
    }

    private func finishStop() {
        guard self.stopped, self.listenerStopped, self.clients.isEmpty else { return }
        let waiters = self.stopWaiters
        self.stopWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func accept(_ connection: NWConnection) {
        let id = UUID()
        let refuse = self.stopped || self.clients.count >= 32
        self.clients[id] = Client(connection: connection)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                if !self.stopped {
                    self.receive(id)
                } else {
                    connection.cancel()
                }
            case .failed:
                connection.cancel()
            case .cancelled:
                self.clients[id] = nil
                self.finishStop()
            default:
                break
            }
        }
        connection.start(queue: self.queue)
        if refuse { connection.cancel() }
    }

    private func receive(_ id: UUID) {
        guard let client = self.clients[id], !self.stopped else { return }
        client.connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: 16384)
        { [weak self] data, _, complete, error in
            guard let self, var client = self.clients[id], !self.stopped else { return }
            if let data, !data.isEmpty {
                guard !client.delivered else {
                    client.connection.cancel()
                    return
                }
                client.buffer.append(data)
                self.clients[id] = client
                do {
                    if let request = try self.request(from: client.buffer) {
                        self.clients[id]?.delivered = true
                        self.deliver(request, id: id)
                    }
                } catch {
                    self.requestContinuation.finish(throwing: error)
                    client.connection.cancel()
                    return
                }
            }
            if complete || error != nil {
                client.connection.cancel()
            } else {
                // Observe a canceled held poll's EOF instead of retaining it until fixture shutdown.
                self.receive(id)
            }
        }
    }

    private func request(from buffer: Data) throws -> URLRequest? {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            guard buffer.count <= Self.maximumHeaderBytes else { throw URLError(.dataLengthExceedsMaximum) }
            return nil
        }
        guard end.upperBound <= Self.maximumHeaderBytes,
              let text = String(data: buffer[..<end.lowerBound], encoding: .utf8)
        else { throw URLError(.cannotParseResponse) }
        let lines = text.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count == 3, first[2] == "HTTP/1.1",
              ["POST", "DELETE"].contains(first[0]),
              let origin = URL(string: "https://localhost:\(self.port)"),
              let url = URL(string: String(first[1]), relativeTo: origin)?.absoluteURL,
              url.scheme == "https", url.host == "localhost", url.port == Int(self.port),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
        else { throw URLError(.badURL) }
        var fields: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw URLError(.cannotParseResponse) }
            let name = line[..<colon].lowercased()
            guard fields[name] == nil else { throw URLError(.cannotParseResponse) }
            fields[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let rawLength = fields["content-length"] ?? "0"
        guard fields["transfer-encoding"] == nil, !rawLength.isEmpty,
              rawLength.utf8.allSatisfy({ (48...57).contains($0) }),
              let length = Int(rawLength), length <= Self.maximumBodyBytes
        else { throw URLError(.dataLengthExceedsMaximum) }
        let total = end.upperBound + length
        guard buffer.count <= total else { throw URLError(.cannotParseResponse) }
        guard buffer.count == total else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = String(first[0])
        request.allHTTPHeaderFields = fields
        request.httpBody = Data(buffer[end.upperBound...])
        return request
    }

    private func deliver(_ request: URLRequest, id: UUID) {
        let exchange = GatewayOperatorHTTPExchange(
            request: request,
            body: request.httpBody ?? Data(),
            respond: { [weak self] status, body in
                self?.queue.async { [weak self] in self?.respond(id, status: status, body: body) }
            },
            fail: { [weak self] _ in
                self?.queue.async { [weak self] in self?.clients[id]?.connection.cancel() }
            })
        self.recorded.append(exchange)
        if request.httpMethod == "DELETE" {
            self.respond(id, status: 204, body: Data())
        }
        self.requestContinuation.yield(exchange)
    }

    private func respond(_ id: UUID, status: Int, body: Data) {
        guard let client = self.clients[id], !self.stopped, !client.responding else { return }
        self.clients[id]?.responding = true
        let headers = "HTTP/1.1 \(status) Fixture\r\nContent-Type: application/json\r\n" +
            "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        client.connection.send(
            content: Data(headers.utf8) + body,
            completion: .contentProcessed { [weak self] error in
                if error == nil { self?.responseStatuses.append(status) }
                client.connection.cancel()
            })
    }

    private static func importIdentity(_ bytes: Data) throws -> (value: sec_identity_t, fingerprint: String) {
        var items: CFArray?
        let options: [String: Any] = [
            kSecImportExportPassphrase as String: "fixture",
            kSecImportToMemoryOnly as String: true,
        ]
        guard SecPKCS12Import(bytes as CFData, options as CFDictionary, &items) == errSecSuccess,
              let imported = (items as? [[String: Any]])?.first?[kSecImportItemIdentity as String],
              CFGetTypeID(imported as CFTypeRef) == SecIdentityGetTypeID()
        else { throw URLError(.clientCertificateRejected) }
        let identity = unsafeDowncast(imported as AnyObject, to: SecIdentity.self)
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess,
              let certificate, let value = sec_identity_create(identity)
        else { throw URLError(.clientCertificateRejected) }
        let der = SecCertificateCopyData(certificate) as Data
        let fingerprint = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        return (value, fingerprint)
    }
}
