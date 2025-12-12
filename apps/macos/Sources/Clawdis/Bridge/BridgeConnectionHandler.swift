import ClawdisNodeKit
import Foundation
import Network
import OSLog

actor BridgeConnectionHandler {
    private let connection: NWConnection
    private let logger: Logger
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let queue = DispatchQueue(label: "com.steipete.clawdis.bridge.connection")

    private var buffer = Data()
    private var isAuthenticated = false
    private var nodeId: String?
    private var pendingInvokes: [String: CheckedContinuation<BridgeInvokeResponse, Error>] = [:]
    private var isClosed = false

    init(connection: NWConnection, logger: Logger) {
        self.connection = connection
        self.logger = logger
    }

    enum AuthResult: Sendable {
        case ok
        case notPaired
        case unauthorized
        case error(code: String, message: String)
    }

    enum PairResult: Sendable {
        case ok(token: String)
        case rejected
        case error(code: String, message: String)
    }

    func run(
        resolveAuth: @escaping @Sendable (BridgeHello) async -> AuthResult,
        handlePair: @escaping @Sendable (BridgePairRequest) async -> PairResult,
        onAuthenticated: (@Sendable (String) async -> Void)? = nil,
        onDisconnected: (@Sendable (String) async -> Void)? = nil,
        onEvent: (@Sendable (String, BridgeEventFrame) async -> Void)? = nil) async
    {
        self.connection.stateUpdateHandler = { [logger] state in
            switch state {
            case .ready:
                logger.debug("bridge conn ready")
            case let .failed(err):
                logger.error("bridge conn failed: \(err.localizedDescription, privacy: .public)")
            default:
                break
            }
        }
        self.connection.start(queue: self.queue)

        while true {
            do {
                guard let line = try await self.receiveLine() else { break }
                guard let data = line.data(using: .utf8) else { continue }
                let base = try self.decoder.decode(BridgeBaseFrame.self, from: data)

                switch base.type {
                case "hello":
                    let hello = try self.decoder.decode(BridgeHello.self, from: data)
                    self.nodeId = hello.nodeId
                    let result = await resolveAuth(hello)
                    await self.handleAuthResult(
                        result,
                        serverName: Host.current().localizedName ?? ProcessInfo.processInfo.hostName)
                    if case .ok = result, let nodeId = self.nodeId {
                        await onAuthenticated?(nodeId)
                    }
                case "pair-request":
                    let req = try self.decoder.decode(BridgePairRequest.self, from: data)
                    self.nodeId = req.nodeId
                    let result = await handlePair(req)
                    await self.handlePairResult(
                        result,
                        serverName: Host.current().localizedName ?? ProcessInfo.processInfo.hostName)
                    if case .ok = result, let nodeId = self.nodeId {
                        await onAuthenticated?(nodeId)
                    }
                case "event":
                    guard self.isAuthenticated, let nodeId = self.nodeId else {
                        await self.sendError(code: "UNAUTHORIZED", message: "not authenticated")
                        continue
                    }
                    let evt = try self.decoder.decode(BridgeEventFrame.self, from: data)
                    await onEvent?(nodeId, evt)
                case "ping":
                    if !self.isAuthenticated {
                        await self.sendError(code: "UNAUTHORIZED", message: "not authenticated")
                        continue
                    }
                    let ping = try self.decoder.decode(BridgePing.self, from: data)
                    try await self.send(BridgePong(type: "pong", id: ping.id))
                case "invoke-res":
                    guard self.isAuthenticated else {
                        await self.sendError(code: "UNAUTHORIZED", message: "not authenticated")
                        continue
                    }
                    let res = try self.decoder.decode(BridgeInvokeResponse.self, from: data)
                    if let cont = self.pendingInvokes.removeValue(forKey: res.id) {
                        cont.resume(returning: res)
                    }
                default:
                    await self.sendError(code: "INVALID_REQUEST", message: "unknown type")
                }
            } catch {
                await self.sendError(code: "INVALID_REQUEST", message: error.localizedDescription)
            }
        }

        await self.close(with: onDisconnected)
    }

    private func handlePairResult(_ result: PairResult, serverName: String) async {
        switch result {
        case let .ok(token):
            do {
                try await self.send(BridgePairOk(type: "pair-ok", token: token))
                self.isAuthenticated = true
                try await self.send(BridgeHelloOk(type: "hello-ok", serverName: serverName))
            } catch {
                self.logger.error("bridge send pair-ok failed: \(error.localizedDescription, privacy: .public)")
            }
        case .rejected:
            await self.sendError(code: "UNAUTHORIZED", message: "pairing rejected")
        case let .error(code, message):
            await self.sendError(code: code, message: message)
        }
    }

    private func handleAuthResult(_ result: AuthResult, serverName: String) async {
        switch result {
        case .ok:
            self.isAuthenticated = true
            do {
                try await self.send(BridgeHelloOk(type: "hello-ok", serverName: serverName))
            } catch {
                self.logger.error("bridge send hello-ok failed: \(error.localizedDescription, privacy: .public)")
            }
        case .notPaired:
            await self.sendError(code: "NOT_PAIRED", message: "pairing required")
        case .unauthorized:
            await self.sendError(code: "UNAUTHORIZED", message: "invalid token")
        case let .error(code, message):
            await self.sendError(code: code, message: message)
        }
    }

    private func sendError(code: String, message: String) async {
        do {
            try await self.send(BridgeErrorFrame(type: "error", code: code, message: message))
        } catch {
            self.logger.error("bridge send error failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func invoke(command: String, paramsJSON: String?) async throws -> BridgeInvokeResponse {
        guard self.isAuthenticated else {
            throw NSError(domain: "Bridge", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "UNAUTHORIZED: not authenticated",
            ])
        }
        let id = UUID().uuidString
        let req = BridgeInvokeRequest(type: "invoke", id: id, command: command, paramsJSON: paramsJSON)

        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: 15 * 1_000_000_000)
            await self.timeoutInvoke(id: id)
        }
        defer { timeoutTask.cancel() }

        return try await withCheckedThrowingContinuation { cont in
            Task { [weak self] in
                guard let self else { return }
                await self.beginInvoke(id: id, request: req, continuation: cont)
            }
        }
    }

    private func beginInvoke(
        id: String,
        request: BridgeInvokeRequest,
        continuation: CheckedContinuation<BridgeInvokeResponse, Error>) async
    {
        self.pendingInvokes[id] = continuation
        do {
            try await self.send(request)
        } catch {
            await self.failInvoke(id: id, error: error)
        }
    }

    private func timeoutInvoke(id: String) async {
        guard let cont = self.pendingInvokes.removeValue(forKey: id) else { return }
        cont.resume(throwing: NSError(domain: "Bridge", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "UNAVAILABLE: invoke timeout",
        ]))
    }

    private func failInvoke(id: String, error: Error) async {
        guard let cont = self.pendingInvokes.removeValue(forKey: id) else { return }
        cont.resume(throwing: error)
    }

    private func send(_ obj: some Encodable) async throws {
        let data = try self.encoder.encode(obj)
        var line = Data()
        line.append(data)
        line.append(0x0A) // \n
        let _: Void = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.connection.send(content: line, completion: .contentProcessed { err in
                if let err {
                    cont.resume(throwing: err)
                } else {
                    cont.resume(returning: ())
                }
            })
        }
    }

    private func receiveLine() async throws -> String? {
        while true {
            if let idx = self.buffer.firstIndex(of: 0x0A) {
                let lineData = self.buffer.prefix(upTo: idx)
                self.buffer.removeSubrange(...idx)
                return String(data: lineData, encoding: .utf8)
            }

            let chunk = try await self.receiveChunk()
            if chunk.isEmpty { return nil }
            self.buffer.append(chunk)
        }
    }

    private func receiveChunk() async throws -> Data {
        try await withCheckedThrowingContinuation { cont in
            self.connection
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
    }

    private func close(with onDisconnected: (@Sendable (String) async -> Void)? = nil) async {
        if self.isClosed { return }
        self.isClosed = true

        let nodeId = self.nodeId
        let pending = self.pendingInvokes.values
        self.pendingInvokes.removeAll()
        for cont in pending {
            cont.resume(throwing: NSError(domain: "Bridge", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "UNAVAILABLE: connection closed",
            ]))
        }

        self.connection.cancel()
        if let nodeId {
            await onDisconnected?(nodeId)
        }
    }
}
