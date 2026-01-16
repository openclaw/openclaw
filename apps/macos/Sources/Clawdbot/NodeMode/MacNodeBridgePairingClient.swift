import ClawdbotKit
import Foundation
import Network

actor MacNodeBridgePairingClient {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var lineBuffer = Data()

    func pairAndHello(
        endpoint: NWEndpoint,
        hello: BridgeHello,
        silent: Bool,
        tls: MacNodeBridgeTLSParams? = nil,
        onStatus: (@Sendable (String) -> Void)? = nil) async throws -> String
    {
        do {
            return try await self.pairAndHelloOnce(
                endpoint: endpoint,
                hello: hello,
                silent: silent,
                tls: tls,
                onStatus: onStatus)
        } catch {
            if let tls, !tls.required {
                return try await self.pairAndHelloOnce(
                    endpoint: endpoint,
                    hello: hello,
                    silent: silent,
                    tls: nil,
                    onStatus: onStatus)
            }
            throw error
        }
    }

    private func pairAndHelloOnce(
        endpoint: NWEndpoint,
        hello: BridgeHello,
        silent: Bool,
        tls: MacNodeBridgeTLSParams?,
        onStatus: (@Sendable (String) -> Void)? = nil) async throws -> String
    {
        self.lineBuffer = Data()
        let params = self.makeParameters(tls: tls)
        let connection = NWConnection(to: endpoint, using: params)
        let queue = DispatchQueue(label: "com.clawdbot.macos.bridge-client")
        defer { connection.cancel() }
        try await AsyncTimeout.withTimeout(
            seconds: 8,
            onTimeout: {
                NSError(domain: "Bridge", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: "connect timed out",
                ])
            },
            operation: {
                try await self.startAndWaitForReady(connection, queue: queue)
            })

        onStatus?("Authenticating…")
        try await self.send(hello, over: connection)

        let first = try await AsyncTimeout.withTimeout(
            seconds: 10,
            onTimeout: {
                NSError(domain: "Bridge", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: "hello timed out",
                ])
            },
            operation: { () -> ReceivedFrame in
                guard let frame = try await self.receiveFrame(over: connection) else {
                    throw NSError(domain: "Bridge", code: 0, userInfo: [
                        NSLocalizedDescriptionKey: "Bridge closed connection during hello",
                    ])
                }
                return frame
            })

        switch first.base.type {
        case "hello-ok":
            return hello.token ?? ""

        case "error":
            let err = try self.decoder.decode(BridgeErrorFrame.self, from: first.data)
            if err.code != "NOT_PAIRED", err.code != "UNAUTHORIZED" {
                throw NSError(domain: "Bridge", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "\(err.code): \(err.message)",
                ])
            }

            onStatus?("Requesting approval…")
            try await self.send(
                BridgePairRequest(
                    nodeId: hello.nodeId,
                    displayName: hello.displayName,
                    platform: hello.platform,
                    version: hello.version,
                    deviceFamily: hello.deviceFamily,
                    modelIdentifier: hello.modelIdentifier,
                    caps: hello.caps,
                    commands: hello.commands,
                    silent: silent),
                over: connection)

            onStatus?("Waiting for approval…")
            let ok = try await AsyncTimeout.withTimeout(
                seconds: 60,
                onTimeout: {
                    NSError(domain: "Bridge", code: 0, userInfo: [
                        NSLocalizedDescriptionKey: "pairing approval timed out",
                    ])
                },
                operation: {
                    while let next = try await self.receiveFrame(over: connection) {
                        switch next.base.type {
                        case "pair-ok":
                            return try self.decoder.decode(BridgePairOk.self, from: next.data)
                        case "error":
                            let e = try self.decoder.decode(BridgeErrorFrame.self, from: next.data)
                            throw NSError(domain: "Bridge", code: 2, userInfo: [
                                NSLocalizedDescriptionKey: "\(e.code): \(e.message)",
                            ])
                        default:
                            continue
                        }
                    }
                    throw NSError(domain: "Bridge", code: 3, userInfo: [
                        NSLocalizedDescriptionKey: "Pairing failed: bridge closed connection",
                    ])
                })

            return ok.token

        default:
            throw NSError(domain: "Bridge", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected bridge response",
            ])
        }
    }

    private func send(_ obj: some Encodable, over connection: NWConnection) async throws {
        let data = try self.encoder.encode(obj)
        var line = Data()
        line.append(data)
        line.append(0x0A)
        try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: line, completion: .contentProcessed { err in
                if let err { cont.resume(throwing: err) } else { cont.resume(returning: ()) }
            })
        }
    }

    private struct ReceivedFrame {
        var base: BridgeBaseFrame
        var data: Data
    }

    private func receiveFrame(over connection: NWConnection) async throws -> ReceivedFrame? {
        guard let lineData = try await self.receiveLineData(over: connection) else {
            return nil
        }
        let base = try self.decoder.decode(BridgeBaseFrame.self, from: lineData)
        return ReceivedFrame(base: base, data: lineData)
    }

    private func receiveChunk(over connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
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
    }

    private func receiveLineData(over connection: NWConnection) async throws -> Data? {
        while true {
            if let idx = self.lineBuffer.firstIndex(of: 0x0A) {
                let line = self.lineBuffer.prefix(upTo: idx)
                self.lineBuffer.removeSubrange(...idx)
                return Data(line)
            }

            let chunk = try await self.receiveChunk(over: connection)
            if chunk.isEmpty { return nil }
            self.lineBuffer.append(chunk)
        }
    }

    private func makeParameters(tls: MacNodeBridgeTLSParams?) -> NWParameters {
        let tcpOptions = NWProtocolTCP.Options()
        if let tlsOptions = makeMacNodeTLSOptions(tls) {
            let params = NWParameters(tls: tlsOptions, tcp: tcpOptions)
            params.includePeerToPeer = true
            return params
        }
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        return params
    }

    private func startAndWaitForReady(
        _ connection: NWConnection,
        queue: DispatchQueue) async throws
    {
        let states = AsyncStream<NWConnection.State> { continuation in
            connection.stateUpdateHandler = { state in
                continuation.yield(state)
                if case .ready = state { continuation.finish() }
                if case .failed = state { continuation.finish() }
                if case .cancelled = state { continuation.finish() }
            }
        }
        connection.start(queue: queue)
        for await state in states {
            switch state {
            case .ready:
                return
            case let .failed(err):
                throw err
            case .cancelled:
                throw NSError(domain: "Bridge", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: "Bridge connection cancelled",
                ])
            default:
                continue
            }
        }
    }
}
