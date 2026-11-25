import ConcurrencyExtras
import Foundation
import Subprocess

final class MacNodeCodexThreadCatalogClient: @unchecked Sendable {
    private let loadRoot: () -> [String: Any]
    private let appServerClient: CodexAppServerThreadClient

    init(
        idleTimeoutSeconds: Double = MacNodeCodexThreadCatalog.defaultIdleTimeoutSeconds,
        loadRoot: @escaping () -> [String: Any] = { OpenClawConfigFile.loadDict() })
    {
        self.loadRoot = loadRoot
        self.appServerClient = CodexAppServerThreadClient(
            idleTimeoutSeconds: idleTimeoutSeconds)
    }

    func list(paramsJSON: String?) async throws -> String {
        try await MacNodeCodexThreadCatalog.list(
            paramsJSON: paramsJSON,
            loadRoot: self.loadRoot,
            client: self.appServerClient)
    }

    func turns(paramsJSON: String?) async throws -> String {
        try await MacNodeCodexThreadCatalog.turns(
            paramsJSON: paramsJSON,
            loadRoot: self.loadRoot,
            client: self.appServerClient)
    }

    func shutdown() async {
        await self.appServerClient.shutdown()
    }
}

final class CodexAppServerThreadClient: @unchecked Sendable {
    struct Response: Sendable {
        let data: Data
        let sourceHomeId: String
    }

    private final class PendingRequest: @unchecked Sendable {
        let token: UUID
        let invocation: MacNodeCodexThreadCatalog.ResolvedInvocation
        let method: String
        let requestParamsData: Data
        let sourceHomeId: String?
        let maxLineBytes: Int
        var requestID: Int?
        var requestData: Data?
        var continuation: CheckedContinuation<Response, Error>?
        var timer: DispatchSourceTimer?
        /// One requeue budget for the child-exit race: a failed stdin write was
        /// never delivered, so a single retry on a fresh child cannot duplicate.
        var redelivered = false

        init(
            token: UUID,
            invocation: MacNodeCodexThreadCatalog.ResolvedInvocation,
            method: String,
            requestParamsData: Data,
            sourceHomeId: String?,
            maxLineBytes: Int,
            continuation: CheckedContinuation<Response, Error>)
        {
            self.token = token
            self.invocation = invocation
            self.method = method
            self.requestParamsData = requestParamsData
            self.sourceHomeId = sourceHomeId
            self.maxLineBytes = maxLineBytes
            self.continuation = continuation
        }
    }

    private final class Connection: @unchecked Sendable {
        let generation = UUID()
        let invocation: MacNodeCodexThreadCatalog.ResolvedInvocation
        let initializeRequestID: Int
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        var process: ManagedProcess?
        var cleanupTask: Task<Void, Never>?
        var readers: [PipeReadStream] = []
        var stdoutBuffer = Data()
        var sourceHomeId: String?

        init(
            invocation: MacNodeCodexThreadCatalog.ResolvedInvocation,
            initializeRequestID: Int)
        {
            self.invocation = invocation
            self.initializeRequestID = initializeRequestID
            // The App Server child can exit between requests; without this an
            // in-flight stdin write raises SIGPIPE and kills the app.
            self.stdinPipe.fileHandleForWriting.disableSIGPIPE()
        }
    }

    private static let maxQueuedRequests = 64
    private static let gracefulShutdownTimeout: Duration = .seconds(
        AppTerminationTiming.cleanupDeadlineSeconds * 0.75)

    private let queue = DispatchQueue(label: "ai.openclaw.codex-thread-catalog")
    private let idleTimeoutSeconds: Double
    private let idleReadLimit: Int
    private var nextRequestID = 1
    private var pending: [PendingRequest] = []
    private var active: PendingRequest?
    private var connection: Connection?
    private var idleTimer: DispatchSourceTimer?

    init(
        idleTimeoutSeconds: Double = MacNodeCodexThreadCatalog.defaultIdleTimeoutSeconds,
        idleReadLimit: Int = 20 * 1024 * 1024)
    {
        self.idleTimeoutSeconds = max(0.01, idleTimeoutSeconds)
        self.idleReadLimit = max(1, idleReadLimit)
    }

    deinit {
        self.cancelIdleTimer()
        self.connection?.process?.requestTermination()
    }

    func request(
        invocation: MacNodeCodexThreadCatalog.ResolvedInvocation,
        method: String,
        requestParams: [String: Any],
        sourceHomeId: String? = nil,
        timeoutSeconds: Double,
        maxLineBytes: Int) async throws -> Response
    {
        try Task.checkCancellation()
        let requestParamsData = try JSONSerialization.data(withJSONObject: requestParams)
        let token = UUID()
        let cancellationState = LockIsolated(false)
        let result: Response = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.queue.async {
                    guard !cancellationState.value else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    guard self.pending.count + (self.active == nil ? 0 : 1) <
                        Self.maxQueuedRequests
                    else {
                        continuation.resume(
                            throwing: MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable)
                        return
                    }
                    let request = PendingRequest(
                        token: token,
                        invocation: invocation,
                        method: method,
                        requestParamsData: requestParamsData,
                        sourceHomeId: sourceHomeId,
                        maxLineBytes: max(1, maxLineBytes),
                        continuation: continuation)
                    // Callers pass the operation's remaining wall-clock deadline.
                    // Queue wait therefore counts, matching the former one-shot session.
                    request.timer = self.makeRequestTimer(
                        token: token,
                        timeoutSeconds: timeoutSeconds)
                    self.pending.append(request)
                    self.cancelIdleTimer()
                    self.startNextIfNeeded()
                }
            }
        } onCancel: {
            cancellationState.setValue(true)
            self.queue.async {
                self.failRequest(token: token, error: CancellationError())
            }
        }
        try Task.checkCancellation()
        return result
    }

    func shutdown() async {
        let cleanup: Task<Void, Never>? = await withCheckedContinuation { continuation in
            self.queue.async {
                self.cancelIdleTimer()
                if let active = self.active {
                    self.active = nil
                    self.complete(active, with: .failure(CancellationError()))
                }
                let pending = self.pending
                self.pending.removeAll()
                for request in pending {
                    self.complete(request, with: .failure(CancellationError()))
                }
                continuation.resume(returning: self.stopConnection(abortive: false))
            }
        }
        await cleanup?.value
    }

    private func takeRequestIDOnQueue() -> Int {
        let requestID = self.nextRequestID
        self.nextRequestID = requestID == Int.max ? 1 : requestID + 1
        return requestID
    }

    private func makeRequestTimer(token: UUID, timeoutSeconds: Double) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now() + max(0.01, timeoutSeconds))
        timer.setEventHandler { [weak self] in
            self?.failRequest(token: token, error: MacNodeCodexThreadCatalog.CatalogError.timedOut)
        }
        timer.resume()
        return timer
    }

    private func startNextIfNeeded() {
        guard self.active == nil, !self.pending.isEmpty else {
            if self.active == nil, self.pending.isEmpty {
                self.scheduleIdleShutdown()
            }
            return
        }
        let request = self.pending[0]
        if let connection = self.connection {
            guard connection.cleanupTask == nil else { return }
            if connection.process?.isRunning != true ||
                connection.invocation != request.invocation
            {
                // Invocation replacement is graceful, but the successor remains
                // fenced until this connection's process and stdout have closed.
                self.stopConnection(abortive: false)
                return
            }
        }
        self.pending.removeFirst()
        self.active = request
        guard let connection = self.connection else {
            self.startConnection(for: request)
            return
        }
        guard connection.sourceHomeId != nil else { return }
        self.sendActiveRequest(over: connection)
    }

    private func startConnection(for request: PendingRequest) {
        let connection = Connection(
            invocation: request.invocation,
            initializeRequestID: self.takeRequestIDOnQueue())
        self.connection = connection
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        for key in request.invocation.clearEnv {
            environment.removeValue(forKey: key)
        }
        let generation = connection.generation
        do {
            connection.readers = try [
                PipeReadStream(
                    handle: connection.stdoutPipe.fileHandleForReading,
                    queue: self.queue,
                    onData: { [weak self] data in
                        guard let self, let current = self.connection,
                              current.generation == generation else { return }
                        self.consumeStdout(data, connection: current)
                    }),
                PipeReadStream(
                    handle: connection.stderrPipe.fileHandleForReading,
                    queue: self.queue,
                    onData: { _ in }),
            ]
        } catch {
            self.retireConnection(connection)
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: false)
            return
        }
        let configuration = Subprocess.Configuration(
            executable: .path(.init(request.invocation.executable)),
            arguments: Arguments(request.invocation.arguments),
            environment: ManagedProcess.environment(from: environment),
            workingDirectory: request.invocation.cwd.map { .init($0.path) })
        // Leave enough of the app's cleanup budget for group termination and joined reaping.
        let process = ManagedProcess.launch(
            configuration: configuration,
            stdin: connection.stdinPipe.fileHandleForReading,
            stdout: connection.stdoutPipe.fileHandleForWriting,
            stderr: connection.stderrPipe.fileHandleForWriting,
            closeStdinForGracefulShutdown: connection.stdinPipe.fileHandleForWriting,
            gracefulShutdownTimeout: Self.gracefulShutdownTimeout)
        connection.process = process
        Task { [weak self] in
            let started = await (try? process.waitUntilStarted()) != nil
            self?.queue.async { [weak self] in
                self?.finishConnectionLaunch(started: started, generation: generation)
            }
        }
    }

    private func finishConnectionLaunch(
        started: Bool,
        generation: UUID)
    {
        guard let connection = self.connection,
              connection.generation == generation,
              connection.cleanupTask == nil
        else { return }
        guard started, let process = connection.process else {
            self.retireConnection(connection)
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: false)
            return
        }
        Task { [weak self, completionTask = process.completionTask] in
            _ = await completionTask.value
            self?.queue.async { [weak self] in
                self?.handleTermination(generation: generation)
            }
        }
        do {
            try self.write(
                Self.initializeRequestData(id: connection.initializeRequestID),
                over: connection)
        } catch {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: true)
        }
    }

    private func sendActiveRequest(over connection: Connection) {
        guard let active = self.active else { return }
        if let sourceHomeId = active.sourceHomeId, sourceHomeId != connection.sourceHomeId {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.invalidParams(
                    "Codex session source changed; refresh the catalog and retry")),
                restartConnection: false)
            return
        }
        do {
            if active.requestData == nil {
                let requestID = self.takeRequestIDOnQueue()
                let requestParams = try JSONSerialization.jsonObject(
                    with: active.requestParamsData)
                active.requestID = requestID
                active.requestData = try JSONSerialization.data(withJSONObject: [
                    "id": requestID,
                    "method": active.method,
                    "params": requestParams,
                ])
            }
            guard let requestData = active.requestData else {
                throw MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable
            }
            try self.write(requestData, over: connection)
        } catch {
            // A warm connection can outlive its child; the exit race surfaces
            // here as EPIPE before termination is observed. The frame was never
            // delivered, so requeue once onto a fresh child instead of failing.
            guard !active.redelivered else {
                self.finishActive(
                    .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                    restartConnection: true)
                return
            }
            active.redelivered = true
            self.active = nil
            self.pending.insert(active, at: 0)
            self.stopConnection(abortive: true)
        }
    }

    private func consumeStdout(
        _ data: Data,
        connection: Connection)
    {
        connection.stdoutBuffer.append(data)

        while let newline = connection.stdoutBuffer.firstIndex(of: 0x0A) {
            let line = connection.stdoutBuffer.prefix(upTo: newline)
            let maxLineBytes = self.active?.maxLineBytes ?? self.idleReadLimit
            guard line.count <= maxLineBytes else {
                self.rejectOversizedFrame()
                return
            }
            connection.stdoutBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            self.handleLine(Data(line), connection: connection)
            guard self.connection?.generation == connection.generation else { return }
        }
        let maxLineBytes = self.active?.maxLineBytes ?? self.idleReadLimit
        guard connection.stdoutBuffer.count <= maxLineBytes else {
            self.rejectOversizedFrame()
            return
        }
    }

    private func rejectOversizedFrame() {
        if self.active == nil {
            self.stopConnection(abortive: true)
            self.startNextIfNeeded()
        } else {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.responseTooLarge),
                restartConnection: true)
        }
    }

    private func handleLine(_ data: Data, connection: Connection) {
        guard let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = (message["id"] as? NSNumber)?.intValue
        else { return }

        if id == connection.initializeRequestID {
            guard message["error"] == nil,
                  let result = message["result"] as? [String: Any],
                  let codexHome = result["codexHome"] as? String,
                  let sourceHomeId = try? MacNodeCodexThreadCatalog.sourceHomeId(codexHome: codexHome)
            else {
                self.finishActive(
                    .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                    restartConnection: true)
                return
            }
            connection.sourceHomeId = sourceHomeId
            do {
                try self.write(JSONSerialization.data(withJSONObject: ["method": "initialized"]), over: connection)
                self.sendActiveRequest(over: connection)
            } catch {
                self.finishActive(
                    .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                    restartConnection: true)
            }
            return
        }

        guard let active = self.active, id == active.requestID else { return }
        guard message["error"] == nil,
              let result = message["result"] as? [String: Any],
              let sourceHomeId = connection.sourceHomeId,
              let resultData = try? JSONSerialization.data(withJSONObject: result)
        else {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: message["error"] == nil)
            return
        }
        self.finishActive(
            .success(Response(data: resultData, sourceHomeId: sourceHomeId)),
            restartConnection: false)
    }

    private func handleTermination(generation: UUID) {
        guard let connection = self.connection, connection.generation == generation else { return }
        self.stopConnection(abortive: false)
    }

    private func failRequest(token: UUID, error: Error) {
        if let index = self.pending.firstIndex(where: { $0.token == token }) {
            let request = self.pending.remove(at: index)
            self.complete(request, with: .failure(error))
            if self.active == nil {
                self.stopConnection(abortive: true)
            }
            return
        }
        guard self.active?.token == token else { return }
        self.finishActive(.failure(error), restartConnection: true)
    }

    private func finishActive(
        _ result: Result<Response, Error>,
        restartConnection: Bool)
    {
        guard let active = self.active else { return }
        self.active = nil
        self.complete(active, with: result)
        if restartConnection {
            self.stopConnection(abortive: true)
        }
        self.startNextIfNeeded()
    }

    private func complete(_ request: PendingRequest, with result: Result<Response, Error>) {
        request.timer?.cancel()
        request.timer = nil
        guard let continuation = request.continuation else { return }
        request.continuation = nil
        continuation.resume(with: result)
    }

    private func scheduleIdleShutdown() {
        guard let connection = self.connection,
              connection.cleanupTask == nil,
              self.idleTimer == nil
        else { return }
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now() + self.idleTimeoutSeconds)
        timer.setEventHandler { [weak self] in
            guard let self, self.active == nil, self.pending.isEmpty else { return }
            self.cancelIdleTimer()
            self.stopConnection(abortive: false)
        }
        self.idleTimer = timer
        timer.resume()
    }

    private func cancelIdleTimer() {
        self.idleTimer?.cancel()
        self.idleTimer = nil
    }

    @discardableResult
    private func stopConnection(abortive: Bool) -> Task<Void, Never>? {
        guard let connection = self.connection else { return nil }
        if let cleanupTask = connection.cleanupTask {
            if abortive {
                connection.process?.requestTermination(gracefully: false)
            }
            return cleanupTask
        }
        guard let process = connection.process else { return nil }
        let generation = connection.generation
        let readers = connection.readers
        let cleanupTask = Task { [weak self] in
            await process.terminate(gracefully: !abortive)
            // A short-lived server can exit before its final frame is consumed.
            // Join both bounded pipe readers before failing the request or admitting a successor.
            for reader in readers {
                await reader.finish()
            }
            await withCheckedContinuation { continuation in
                guard let self else {
                    continuation.resume()
                    return
                }
                self.queue.async {
                    if let current = self.connection, current.generation == generation {
                        self.retireConnection(current)
                        if self.active != nil {
                            self.finishActive(
                                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                                restartConnection: false)
                        } else {
                            self.startNextIfNeeded()
                        }
                    }
                    continuation.resume()
                }
            }
        }
        connection.cleanupTask = cleanupTask
        return cleanupTask
    }

    private func retireConnection(_ connection: Connection) {
        guard self.connection?.generation == connection.generation else { return }
        self.connection = nil
        connection.readers.forEach { $0.close() }
        try? connection.stdinPipe.fileHandleForWriting.close()
        try? connection.stdoutPipe.fileHandleForReading.close()
        try? connection.stderrPipe.fileHandleForReading.close()
    }

    private func write(_ data: Data, over connection: Connection) throws {
        var frame = data
        frame.append(0x0A)
        try connection.stdinPipe.fileHandleForWriting.write(contentsOf: frame)
    }

    private static func initializeRequestData(id: Int) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "id": id,
            "method": "initialize",
            "params": [
                "clientInfo": [
                    "name": "openclaw_macos",
                    "title": "OpenClaw macOS Node",
                    "version": GatewayEnvironment.appVersionString() ?? "unknown",
                ],
                "capabilities": ["experimentalApi": true],
            ],
        ])
    }
}
