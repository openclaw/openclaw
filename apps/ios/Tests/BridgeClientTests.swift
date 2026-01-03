import ClawdisKit
import Foundation
import Network
import Testing
@testable import Clawdis

@Suite struct BridgeClientTests {
    private final class LineServer: @unchecked Sendable {
        private let queue = DispatchQueue(label: "com.clawdis.tests.bridge-client-server")
        private let listener: NWListener
        private var connection: NWConnection?
        private var buffer = Data()

        init() throws {
            self.listener = try NWListener(using: .tcp, on: .any)
        }

        func start() async throws -> NWEndpoint.Port {
            try await withCheckedThrowingContinuation(isolation: nil) { cont in
                self.listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if let port = self.listener.port {
                            cont.resume(returning: port)
                        } else {
                            cont.resume(
                                throwing: NSError(domain: "LineServer", code: 1, userInfo: [
                                    NSLocalizedDescriptionKey: "listener missing port",
                                ]))
                        }
                    case let .failed(err):
                        cont.resume(throwing: err)
                    default:
                        break
                    }
                }

                self.listener.newConnectionHandler = { [weak self] conn in
                    guard let self else { return }
                    self.connection = conn
                    conn.start(queue: self.queue)
                }

                self.listener.start(queue: self.queue)
            }
        }

        func stop() {
            self.connection?.cancel()
            self.connection = nil
            self.listener.cancel()
        }

        func waitForConnection(timeoutMs: Int = 2000) async throws -> NWConnection {
            let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
            while Date() < deadline {
                if let connection = self.connection { return connection }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            throw NSError(domain: "LineServer", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "timed out waiting for connection",
            ])
        }

        func receiveLine(timeoutMs: Int = 2000) async throws -> Data? {
            let connection = try await self.waitForConnection(timeoutMs: timeoutMs)
            let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)

            while Date() < deadline {
                if let idx = self.buffer.firstIndex(of: 0x0A) {
                    let line = self.buffer.prefix(upTo: idx)
                    self.buffer.removeSubrange(...idx)
                    return Data(line)
                }

                let chunk = try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<
                    Data,
                    Error,
                >) in
                    connection
                        .receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                            if let error {
                                cont.resume(throwing: error)
                                return
                            }
                            if isComplete {
                                cont.resume(returning: Data())
                                return
                            }
                            cont.resume(returning: data ?? Data())
                        }
                }

                if chunk.isEmpty { return nil }
                self.buffer.append(chunk)
            }

            throw NSError(domain: "LineServer", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "timed out waiting for line",
            ])
        }

        func sendLine(_ line: String) async throws {
            let connection = try await self.waitForConnection()
            var data = Data(line.utf8)
            data.append(0x0A)
            try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
                connection.send(content: data, completion: .contentProcessed { err in
                    if let err { cont.resume(throwing: err) } else { cont.resume(returning: ()) }
                })
            }
        }
    }

    @Test func helloOkReturnsExistingToken() async throws {
        let server = try LineServer()
        let port = try await server.start()
        defer { server.stop() }

        let serverTask = Task {
            let line = try await server.receiveLine()
            #expect(line != nil)
            _ = try JSONDecoder().decode(BridgeHello.self, from: line ?? Data())
            try await server.sendLine(#"{"type":"hello-ok","serverName":"Test Gateway"}"#)
        }
        defer { serverTask.cancel() }

        let client = BridgeClient()
        let token = try await client.pairAndHello(
            endpoint: .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: port),
            hello: BridgeHello(
                nodeId: "ios-node",
                displayName: "iOS",
                token: "existing-token",
                platform: "ios",
                version: "1"),
            onStatus: nil)

        #expect(token == "existing-token")
        _ = try await serverTask.value
    }

    @Test func notPairedTriggersPairRequestAndReturnsToken() async throws {
        let server = try LineServer()
        let port = try await server.start()
        defer { server.stop() }

        let serverTask = Task {
            let helloLine = try await server.receiveLine()
            #expect(helloLine != nil)
            _ = try JSONDecoder().decode(BridgeHello.self, from: helloLine ?? Data())
            try await server.sendLine(#"{"type":"error","code":"NOT_PAIRED","message":"not paired"}"#)

            let pairLine = try await server.receiveLine()
            #expect(pairLine != nil)
            _ = try JSONDecoder().decode(BridgePairRequest.self, from: pairLine ?? Data())
            try await server.sendLine(#"{"type":"pair-ok","token":"paired-token"}"#)
        }
        defer { serverTask.cancel() }

        let client = BridgeClient()
        let token = try await client.pairAndHello(
            endpoint: .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: port),
            hello: BridgeHello(nodeId: "ios-node", displayName: "iOS", token: nil, platform: "ios", version: "1"),
            onStatus: nil)

        #expect(token == "paired-token")
        _ = try await serverTask.value
    }

    @Test func unexpectedErrorIsSurfaced() async {
        do {
            let server = try LineServer()
            let port = try await server.start()
            defer { server.stop() }

            let serverTask = Task {
                let helloLine = try await server.receiveLine()
                #expect(helloLine != nil)
                _ = try JSONDecoder().decode(BridgeHello.self, from: helloLine ?? Data())
                try await server.sendLine(#"{"type":"error","code":"NOPE","message":"nope"}"#)
            }
            defer { serverTask.cancel() }

            let client = BridgeClient()
            _ = try await client.pairAndHello(
                endpoint: .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: port),
                hello: BridgeHello(nodeId: "ios-node", displayName: "iOS", token: nil, platform: "ios", version: "1"),
                onStatus: nil)

            Issue.record("Expected pairAndHello to throw for unexpected error code")
        } catch {
            #expect(error.localizedDescription.contains("NOPE"))
        }
    }
}
