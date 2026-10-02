import CryptoKit
import Darwin
import Foundation
import OpenClawKit

/// A product-owned process transport. Gateway credentials still come from the native auth owner.
package final class RustGatewayWebSocketSession: WebSocketSessioning, GatewayTLSRouteMetadataProviding,
GatewayTLSFailureProviding, GatewayDeviceTokenRetryTrustProviding, @unchecked Sendable {
    private let startupLock = NSLock()
    private var startup: Startup?
    private let executableURL: URL
    private let privateCommands: Set<String>
    private let trustOwner: GatewayTLSPinningSession

    /// Owns one authenticated child before its final Gateway route is available.
    /// Consuming transfers retirement to the WebSocket task; this token then becomes inert.
    package final class Startup: @unchecked Sendable {
        private let lock = NSLock()
        private let executableURL: URL
        private var task: RustGatewayWebSocketTask?

        package init(executableURL: URL) {
            self.executableURL = executableURL
            self.task = RustGatewayWebSocketTask(executableURL: executableURL)
        }

        deinit { self.cancel() }

        package func prepare() async throws {
            guard let task = self.lock.withLock({ self.task }) else { throw URLError(.cancelled) }
            try await task.prepare()
        }

        @discardableResult
        package func cancel() -> Bool {
            self.lock.withLock {
                guard let task = self.task else { return false }
                task.finish(URLError(.cancelled))
                return true
            }
        }

        fileprivate func consume(
            executableURL: URL,
            configuration: RustGatewayWebSocketTask.Configuration) throws -> RustGatewayWebSocketTask
        {
            try self.lock.withLock {
                guard let task = self.task, self.executableURL == executableURL else {
                    throw URLError(.cancelled)
                }
                try task.configure(configuration)
                self.task = nil
                return task
            }
        }
    }

    package static var bundledExecutableURL: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/openclaw-mac-node-sidecar")
    }

    package static func _testRetainsBufferedFrameAfterFinish(_ data: Data, connectID: String?) -> Bool {
        self.retainsBufferedFrameAfterFinish(data, connectID: connectID)
    }

    package static func _testRejectsDeliveryAfterFinish(_ data: Data) -> Bool {
        RustGatewayWebSocketTask._testRejectsDeliveryAfterFinish(data)
    }

    static func framePrefix(callerOwnsLifetime: Bool) -> Data {
        Data("{\"type\":\"frame\",\"callerOwnsLifetime\":\(callerOwnsLifetime),\"frame\":".utf8)
    }

    static func gatewayFrameMetadata(_ data: Data) throws -> (id: String?, method: String?, commands: Set<String>?) {
        // Gateway writers produce UTF-8 JSON objects. Reject alternate encodings and
        // non-objects before embedding their exact bytes in the authenticated envelope.
        let start = data.drop(while: { [0x20, 0x09, 0x0A, 0x0D].contains($0) })
        guard start.first == 0x7B, start.dropFirst().first != 0,
              let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw URLError(.cannotParseResponse) }
        let method = frame["method"] as? String
        let params = frame["params"] as? [String: Any]
        return (
            frame["id"] as? String,
            method,
            method == "connect" ? Set(params?["commands"] as? [String] ?? []) : nil)
    }

    package init(
        executableURL: URL,
        fingerprint: String? = nil,
        tlsParams: GatewayTLSParams? = nil,
        privateCommands: [String] = [],
        startup: Startup? = nil)
    {
        self.executableURL = executableURL
        self.startup = startup
        self.privateCommands = Set(privateCommands)
        self.trustOwner = GatewayTLSPinningSession(params: tlsParams ?? GatewayTLSParams(
            required: true, expectedFingerprint: fingerprint, allowTOFU: false, storeKey: nil))
    }

    package var effectiveTLSFingerprintSHA256: String? {
        self.trustOwner.effectiveTLSFingerprintSHA256
    }

    package var allowsDeviceTokenRetryAuth: Bool {
        self.trustOwner.allowsDeviceTokenRetryAuth
    }

    package func consumeLastTLSFailure() -> GatewayTLSValidationFailure? {
        self.trustOwner.consumeLastTLSFailure()
    }

    package func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    package func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        let configuration = RustGatewayWebSocketTask.Configuration(
            request: request, privateCommands: self.privateCommands, trustOwner: self.trustOwner)
        do {
            let prepared = try self.startupLock.withLock { () -> RustGatewayWebSocketTask? in
                guard let startup = self.startup else { return nil }
                // A retired, unclaimed startup remains a failure. Only successful
                // consumption allows later reconnects to launch a fresh child.
                let task = try startup.consume(executableURL: self.executableURL, configuration: configuration)
                self.startup = nil
                return task
            }
            if let prepared { return WebSocketTaskBox(task: prepared) }
        } catch {
            let failed = RustGatewayWebSocketTask(executableURL: self.executableURL)
            failed.finish(error)
            return WebSocketTaskBox(task: failed)
        }
        return WebSocketTaskBox(task: RustGatewayWebSocketTask(
            executableURL: self.executableURL, configuration: configuration))
    }

    fileprivate static func retainsBufferedFrameAfterFinish(_ data: Data, connectID: String?) -> Bool {
        guard let connectID,
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              frame["type"] as? String == "res",
              frame["id"] as? String == connectID,
              frame["ok"] as? Bool == false
        else {
            return false
        }
        return true
    }
}

private final class RustGatewayWebSocketTask: WebSocketRequestSending, @unchecked Sendable {
    /// Product IPC requires the native relay; older helpers must fail before opening a Gateway socket.
    private enum Feature {
        static let nativeRelay = 1
        static let pongReceipt = 2
        static let binaryMessage = 4
        static let nativeResult = 16
        static let opaqueTransport = 64
        static let required = nativeRelay | pongReceipt | binaryMessage | nativeResult | opaqueTransport
    }

    struct Configuration: Sendable {
        let request: URLRequest
        let privateCommands: Set<String>
        let trustOwner: GatewayTLSPinningSession
    }

    private enum Phase { case suspended, preparing, prepared, running, completed }

    private let lock = NSLock()
    private let writes = SidecarWriteQueue()
    private let reader = DispatchQueue(label: "ai.openclaw.sidecar.read")
    private let executableURL: URL
    private var configuration: Configuration?
    private var preparation: CheckedContinuation<Void, Error>?
    private var network: NativeGatewayTransport?
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var channel: AuthenticatedSidecarChannel?
    private var phase = Phase.suspended
    private var taskState: URLSessionTask.State {
        switch self.phase {
        case .suspended, .prepared: .suspended
        case .preparing, .running: .running
        case .completed: .completed
        }
    }

    private var failure: Error?
    private var buffered: [Data] = []
    private var bufferedBytes = 0
    private var receivers: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = []
    private var pings: [String: @Sendable (Error?) -> Void] = [:]
    private var declaredCommands = Set<String>()
    private var connectID: String?
    private var admitted = false

    init(executableURL: URL, configuration: Configuration? = nil) {
        self.executableURL = executableURL
        self.configuration = configuration
    }

    /// A claimed task can be discarded before resume; its parked child still
    /// belongs to this task and must not survive the last reference.
    deinit { self.finish(URLError(.cancelled)) }

    var state: URLSessionTask.State {
        self.lock.withLock { self.taskState }
    }

    func configure(_ configuration: Configuration) throws {
        try self.lock.withLock {
            guard self.phase == .prepared, self.process?.isRunning == true else {
                throw self.failure ?? URLError(.networkConnectionLost)
            }
            self.configuration = configuration
        }
    }

    func prepare() async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let needsPreparation: Bool? = self.lock.withLock {
                    if self.phase == .prepared, self.process?.isRunning == true { return false }
                    guard self.phase == .suspended else { return nil }
                    self.phase = .preparing
                    self.preparation = continuation
                    return true
                }
                guard let needsPreparation else {
                    continuation.resume(throwing: self.lock.withLock { self.failure } ?? URLError(.cancelled))
                    return
                }
                guard needsPreparation else {
                    continuation.resume()
                    return
                }
                self.reader.async { [self] in
                    do {
                        try self.prepareProcess()
                        let prepared = try self.lock.withLock {
                            guard self.phase == .preparing, self.process?.isRunning == true else {
                                throw self.failure ?? URLError(.networkConnectionLost)
                            }
                            self.phase = .prepared
                            defer { self.preparation = nil }
                            return self.preparation
                        }
                        prepared?.resume()
                    } catch { self.finish(error) }
                }
            }
        } onCancel: {
            self.finish(URLError(.cancelled))
        }
    }

    func resume() {
        let needsPreparation: Bool? = self.lock.withLock {
            switch self.phase {
            case .suspended:
                self.phase = .preparing
                return true
            case .prepared:
                self.phase = .running
                return false
            default: return nil
            }
        }
        guard let needsPreparation else { return }
        self.reader.async { [self] in
            do {
                if needsPreparation {
                    try self.prepareProcess()
                    try self.lock.withLock {
                        guard self.phase == .preparing else { throw self.failure ?? URLError(.cancelled) }
                        self.phase = .running
                    }
                }
                try self.runActive()
            } catch { self.finish(error) }
        }
    }

    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
        self.finish(URLError(.cancelled))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let data: Data
        switch message {
        case let .data(value): data = value
        case let .string(value): data = Data(value.utf8)
        @unknown default: throw URLError(.unknown)
        }
        // Raw WebSocket callers (including the capacity probe) have no encoder-owned
        // metadata. Validate their complete JSON before it reaches the inherited pipe.
        try await self.send(
            SidecarPayload(
                data, prefix: RustGatewayWebSocketSession.framePrefix(callerOwnsLifetime: false), suffix: Data([0x7D])),
            lifetime: nil)
        {
            try autoreleasepool {
                try RustGatewayWebSocketSession.gatewayFrameMetadata(data)
            }
        }
    }

    func sendRequest(_ request: PreparedGatewayRequest, lifetime: WebSocketRequestLifetime?) async throws {
        let payload = switch request.body {
        case let .frame(data):
            SidecarPayload(
                data,
                prefix: RustGatewayWebSocketSession.framePrefix(callerOwnsLifetime: lifetime != nil),
                suffix: Data([0x7D]))
        case let .nativeResult(metadata, payloadJSON):
            // Raw JSON is last in a closed tuple: it cannot inject or replace frozen
            // metadata. Rust validates the tuple and standalone value before delivery.
            SidecarPayload(
                body: .utf8(payloadJSON),
                prefix: Data("[\"native-result\",".utf8) + metadata + Data([0x2C]),
                suffix: Data([0x5D]))
        }
        try await self.send(payload, lifetime: lifetime) {
            (request.id, request.method, request.commands)
        }
    }

    private func send(
        _ payload: SidecarPayload,
        lifetime: WebSocketRequestLifetime?,
        metadata: @escaping @Sendable () throws -> (id: String?, method: String?, commands: Set<String>?)) async throws
    {
        try await withCheckedThrowingContinuation { continuation in
            self.writes.enqueue(
                payload,
                lane: lifetime == nil ? .delivery : lifetime?
                    .method == "node.invoke.progress" ? .progress : .application,
                lifetime: lifetime,
                continuation: continuation,
                prepare: { [self] _ in
                    let metadata = try metadata()
                    if let commands = metadata.commands {
                        self.lock.withLock {
                            self.declaredCommands = commands
                            self.connectID = metadata.id
                        }
                    }
                    var cancellation: Data?
                    if let lifetime {
                        guard lifetime.method == nil || lifetime.method == metadata.method else {
                            throw URLError(.cannotParseResponse)
                        }
                        guard let id = metadata.id else {
                            throw URLError(.cannotParseResponse)
                        }
                        cancellation = try JSONSerialization.data(withJSONObject: [
                            "type": "cancel-request",
                            "id": id,
                        ])
                    }
                    return (payload, cancellation)
                },
                write: { [self] data in try self.writePayload(data) },
                failed: { [weak self] error in self?.finish(error) })
        }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        let id = UUID().uuidString
        let accepted = self.lock.withLock {
            guard self.failure == nil, self.taskState == .running, self.pings.count < 64 else { return false }
            self.pings[id] = pongReceiveHandler
            return true
        }
        guard accepted else {
            pongReceiveHandler(URLError(.networkConnectionLost))
            return
        }
        Task {
            do { try await self.write(
                SidecarPayload(JSONSerialization.data(withJSONObject: ["type": "ping", "id": id])),
                lane: .keepalive) } catch { self.finish(error) }
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            self.lock.lock()
            if !self.buffered.isEmpty {
                let data = self.buffered.removeFirst()
                self.bufferedBytes -= data.count
                self.lock.unlock()
                continuation.resume(returning: .data(data))
            } else if let failure = self.failure {
                self.lock.unlock()
                continuation.resume(throwing: failure)
            } else {
                self.receivers.append(continuation)
                self.lock.unlock()
            }
        }
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        Task {
            do { try await completionHandler(.success(self.receive())) } catch { completionHandler(.failure(error)) }
        }
    }

    private func prepareProcess() throws {
        guard FileManager.default.isExecutableFile(atPath: self.executableURL.path) else {
            throw Self.startupError(3, "The macOS node runtime helper is missing or not executable.")
        }
        if self.executableURL == RustGatewayWebSocketSession.bundledExecutableURL {
            try self.verifyBundledArtifact()
        }
        let child = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        child.executableURL = self.executableURL
        child.standardInput = stdinPipe
        child.standardOutput = stdoutPipe
        child.standardError = FileHandle.nullDevice
        // No inherited Gateway/provider credentials, shell, working directory, or operator HOME.
        child.environment = ["LANG": "en_US.UTF-8"]
        child.currentDirectoryURL = FileManager.default.temporaryDirectory
        for descriptor in [
            stdinPipe.fileHandleForWriting.fileDescriptor,
            stdoutPipe.fileHandleForReading.fileDescriptor,
        ] {
            guard fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK) != -1 else {
                throw POSIXError(.EIO)
            }
        }
        guard fcntl(stdinPipe.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else {
            throw POSIXError(.EIO)
        }
        child.terminationHandler = { [weak self] _ in
            // Active reads already deliver authenticated terminal failures. A parked
            // child has no reader, so its death must retire preparation here instead.
            guard let self, self.lock.withLock({ self.phase == .prepared }) else { return }
            self.finish(URLError(.networkConnectionLost))
        }
        try self.launch(child, input: stdinPipe.fileHandleForWriting, output: stdoutPipe.fileHandleForReading)
        try stdinPipe.fileHandleForReading.close()
        try stdoutPipe.fileHandleForWriting.close()
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let sessionBytes = SymmetricKey(size: .bits128).withUnsafeBytes { Data($0) }
        let sessionID = sessionBytes.map { String(format: "%02x", $0) }.joined()
        let channel = try AuthenticatedSidecarChannel(key: key, sessionID: sessionID, generation: 1)
        try self.lock.withLock {
            guard self.phase == .preparing else { throw self.failure ?? URLError(.cancelled) }
            self.channel = channel
        }
        var bootstrap = key + sessionBytes
        bootstrap.append(contentsOf: [0, 0, 0, 0, 0, 0, 0, 1])
        try self.writes.queue.sync {
            try Self.writeExactly(SidecarPayload(bootstrap), to: stdinPipe.fileHandleForWriting)
        }
        bootstrap.resetBytes(in: bootstrap.startIndex..<bootstrap.endIndex)
        let limits: [String: Any] = [
            "maxFrameBytes": channel.maxFrameBytes, "maxInFlight": 64, "bootstrapTimeoutMs": 10000,
        ]
        let offer: [String: Any] = [
            "protocolMajor": 1, "protocolMinor": 0, "featureBits": Feature.required, "limits": limits,
            "peer": [
                "role": "supervisor",
                "name": "openclaw-macos",
                "version": "0.1.0",
                "artifactIdentity": "bundled-macos-app",
            ],
        ]
        let acceptance: [String: Any]
        do {
            try self.writeNow(["type": "offer", "offer": offer])
            guard case let .control(message) = try self.readMessage(
                stdoutPipe.fileHandleForReading,
                bootstrap: true)
            else { throw URLError(.cannotParseResponse) }
            acceptance = message
        } catch {
            throw Self.startupError(4, "The macOS node runtime helper protocol is incompatible.")
        }
        guard acceptance["type"] as? String == "accept",
              let remote = acceptance["offer"] as? [String: Any],
              let peer = remote["peer"] as? [String: Any], peer["role"] as? String == "runtime",
              peer["name"] as? String == "openclaw-mac-node-sidecar",
              remote["protocolMajor"] as? Int == 1, remote["protocolMinor"] as? Int == 0,
              let remoteLimits = remote["limits"] as? [String: Int],
              let selection = acceptance["selection"] as? [String: Any],
              selection["protocolMajor"] as? Int == 1, selection["protocolMinor"] as? Int == 0,
              selection["featureBits"] as? Int == Feature.required,
              let selectedLimits = selection["limits"] as? [String: Int],
              selectedLimits["maxFrameBytes"] == min(remoteLimits["maxFrameBytes"] ?? 0, channel.maxFrameBytes),
              selectedLimits["maxInFlight"] == min(remoteLimits["maxInFlight"] ?? 0, 64),
              selectedLimits["bootstrapTimeoutMs"] == min(remoteLimits["bootstrapTimeoutMs"] ?? 0, 10000),
              (selectedLimits["maxInFlight"] ?? 0) > 0,
              (selectedLimits["bootstrapTimeoutMs"] ?? 0) > 0,
              let frameLimit = selectedLimits["maxFrameBytes"]
        else { throw Self.startupError(4, "The macOS node runtime helper protocol is incompatible.") }
        try self.lock.withLock {
            try channel.lowerFrameLimit(frameLimit)
            channel.lockFrameLimit(opaqueTransport: true)
        }
    }

    private func runActive() throws {
        let (configuration, output) = try self.lock.withLock {
            guard self.phase == .running, self.process?.isRunning == true,
                  let configuration = self.configuration, let output = self.output
            else { throw self.failure ?? URLError(.networkConnectionLost) }
            return (configuration, output)
        }
        guard let url = configuration.request.url else { throw URLError(.badURL) }
        try self.writeNow([
            "type": "open",
            "url": url.absoluteString,
            "privateCommands": configuration.privateCommands.sorted(),
        ])
        let network = NativeGatewayTransport(
            socket: configuration.trustOwner.makeWebSocketTask(request: configuration.request),
            write: { [weak self] data, lane in
                guard let self else { throw URLError(.cancelled) }
                try await self.write(data, lane: lane)
            },
            failed: { [weak self] error in self?.finish(error) })
        let installedNetwork = self.lock.withLock {
            guard self.taskState == .running else { return false }
            self.network = network
            return true
        }
        guard installedNetwork else { network.close()
            return
        }
        network.start()
        while self.state == .running {
            try autoreleasepool {
                // Release parsed control objects after dispatch; each read owns its frame.
                let message = try self.readMessage(output)
                try self.handle(message)
            }
        }
    }

    private func handle(_ message: SidecarRuntimeMessage) throws {
        switch message {
        case let .transport(write):
            guard let network = self.lock.withLock({ self.network }) else { throw URLError(.cancelled) }
            try network.send(write)
        case let .control(control): try self.handleControl(control)
        }
    }

    private func handleControl(_ message: [String: Any]) throws {
        switch message["type"] as? String {
        case "transport-received":
            guard let network = self.lock.withLock({ self.network }) else { throw URLError(.cancelled) }
            try network.received()
        case "frame":
            guard let frame = message["frame"] else { throw URLError(.cannotParseResponse) }
            if let response = frame as? [String: Any], response["type"] as? String == "res" {
                self.lock.withLock {
                    if response["id"] as? String == self.connectID {
                        self.admitted = response["ok"] as? Bool == true
                    }
                }
            }
            try self.deliver(JSONSerialization.data(withJSONObject: frame))
        case "admit":
            guard let id = message["id"] as? String, let command = message["command"] as? String else {
                throw URLError(.cannotParseResponse)
            }
            // This admission is the immutable native connection lease. The existing
            // command handler then rechecks current route authority and OS permissions.
            let allowed = self.lock.withLock {
                self.admitted && self
                    .taskState == .running &&
                    (self.declaredCommands.contains(command) || self.configuration?.privateCommands
                        .contains(command) == true)
            }
            // The reader must keep draining transport receipts while the pipe writer is busy.
            try self.enqueueWrite(SidecarPayload(JSONSerialization.data(withJSONObject: [
                "type": "admission", "id": id, "allowed": allowed,
            ])), lane: .admission)
        case "pong":
            guard let id = message["id"] as? String else { throw URLError(.cannotParseResponse) }
            let callback = self.lock.withLock { self.pings.removeValue(forKey: id) }
            callback?(message["ok"] as? Bool == true ? nil : URLError(.networkConnectionLost))
        case "failure":
            throw NSError(domain: "OpenClawRustSidecar", code: 1, userInfo: [
                NSLocalizedDescriptionKey: message["message"] as? String ?? "Rust sidecar disconnected",
            ])
        default: throw URLError(.cannotParseResponse)
        }
    }

    private func readMessage(
        _ handle: FileHandle,
        bootstrap: Bool = false) throws -> SidecarRuntimeMessage
    {
        // A healthy connection may stay idle indefinitely. Once a frame is readable,
        // one budget covers its whole prefix and body, including a peer that dribbles bytes.
        if !bootstrap { try Self.waitForPipe(handle.fileDescriptor, events: Int16(POLLIN), deadline: nil) }
        let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        let prefix = try Self.readExactly(4, from: handle, deadline: deadline)
        let count = prefix.reduce(0) { ($0 << 8) | Int($1) }
        guard count >= 65, count <= self.lock.withLock({ self.channel?.maxFrameBytes ?? 0 }) else {
            throw URLError(.dataLengthExceedsMaximum)
        }
        // This bounded frame has a final size. Own its storage through Data so the
        // authenticated network slice can outlive the reader without growth headroom.
        let storage = UnsafeMutableRawPointer.allocate(byteCount: count, alignment: 1)
        storage.initializeMemory(as: UInt8.self, repeating: 0, count: count)
        var frame = Data(bytesNoCopy: storage, count: count, deallocator: .custom { bytes, _ in bytes.deallocate() })
        try Self.readExactly(count, from: handle, deadline: deadline, into: &frame)
        return try self.lock.withLock {
            guard let channel = self.channel else { throw URLError(.cancelled) }
            return try channel.open(
                frame,
                decode: { try SidecarRuntimeMessage($0) },
                transport: bootstrap ? nil : { try SidecarRuntimeMessage(transport: $0) })
        }
    }

    private func launch(_ child: Process, input: FileHandle? = nil, output: FileHandle? = nil) throws {
        try self.lock.withLock {
            // Publish the child in the same critical section as launch: cancellation
            // must either prevent execution or own its cleanup before any keys exist.
            guard self.phase == .preparing, self.process == nil else {
                throw self.failure ?? URLError(.cancelled)
            }
            try child.run()
            self.process = child
            self.input = input
            self.output = output
        }
    }

    private func verifyBundledArtifact() throws {
        let verifier = Process()
        verifier.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        verifier.arguments = [
            "--verify", "--deep", "--strict", "--all-architectures",
            Bundle.main.bundleURL.path, RustGatewayWebSocketSession.bundledExecutableURL.path,
        ]
        verifier.environment = ["LANG": "en_US.UTF-8"]
        verifier.currentDirectoryURL = FileManager.default.temporaryDirectory
        verifier.standardInput = FileHandle.nullDevice
        verifier.standardOutput = FileHandle.nullDevice
        verifier.standardError = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        verifier.terminationHandler = { _ in exited.signal() }
        let deadline = DispatchTime.now() + 10
        // Match the packaged app's strict verification policy in an ephemeral OS
        // process, so signature-validation scratch memory dies before helper startup.
        try self.launch(verifier)
        guard exited.wait(timeout: deadline) == .success else {
            if verifier.isRunning { kill(verifier.processIdentifier, SIGKILL) }
            throw URLError(.timedOut)
        }
        guard verifier.terminationReason == .exit, verifier.terminationStatus == 0 else {
            throw NSError(domain: "OpenClawRustSidecar", code: 2, userInfo: [
                NSLocalizedDescriptionKey:
                    "The bundled node runtime failed signature verification. Reinstall the signed app.",
            ])
        }
        try self.lock.withLock {
            guard self.phase == .preparing, self.process === verifier else {
                throw self.failure ?? URLError(.cancelled)
            }
            self.process = nil
        }
    }

    private static func startupError(_ code: Int, _ description: String) -> NSError {
        NSError(domain: "OpenClawRustSidecarStartup", code: code, userInfo: [
            NSLocalizedDescriptionKey: description,
        ])
    }

    private static func waitForPipe(_ descriptor: Int32, events: Int16, deadline: UInt64?) throws {
        while true {
            let timeout: Int32
            if let deadline {
                let now = DispatchTime.now().uptimeNanoseconds
                guard now < deadline else { throw URLError(.timedOut) }
                timeout = Int32(min((deadline - now) / 1_000_000 + 1, UInt64(Int32.max)))
            } else { timeout = -1 }
            var entry = pollfd(fd: descriptor, events: events, revents: 0)
            let result = poll(&entry, 1, timeout)
            if result > 0 { return }
            if result == 0 { throw URLError(.timedOut) }
            if errno != EINTR { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
    }

    private static func readExactly(_ count: Int, from handle: FileHandle, deadline: UInt64) throws -> Data {
        var data = Data()
        try Self.readExactly(count, from: handle, deadline: deadline, into: &data)
        return data
    }

    private static func readExactly(
        _ count: Int,
        from handle: FileHandle,
        deadline: UInt64,
        into data: inout Data) throws
    {
        let descriptor = handle.fileDescriptor
        data.count = count
        try data.withUnsafeMutableBytes { bytes in
            var offset = 0
            while offset < count {
                try Self.waitForPipe(descriptor, events: Int16(POLLIN), deadline: deadline)
                let size = Darwin.read(descriptor, bytes.baseAddress!.advanced(by: offset), count - offset)
                if size > 0 {
                    offset += size
                } else if size == 0 {
                    throw URLError(.networkConnectionLost)
                } else if errno != EINTR,
                          errno != EAGAIN { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            }
        }
    }

    private static func writeExactly(_ payload: SidecarPayload, to handle: FileHandle) throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        let descriptor = handle.fileDescriptor
        // One queue request and deadline cover the entire authenticated frame;
        // controls cannot interleave with borrowed payload segments.
        for data in payload.segments {
            try data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < data.count {
                    try Self.waitForPipe(descriptor, events: Int16(POLLOUT), deadline: deadline)
                    let size = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), data.count - offset)
                    if size > 0 { offset += size } else if size == 0 || (errno != EINTR && errno != EAGAIN) {
                        throw URLError(.networkConnectionLost)
                    }
                }
            }
        }
    }

    private func write(_ data: SidecarPayload, lane: SidecarWriteQueue.Lane) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.enqueueWrite(data, lane: lane, continuation: continuation)
        }
    }

    private func enqueueWrite(
        _ data: SidecarPayload,
        lane: SidecarWriteQueue.Lane,
        continuation: CheckedContinuation<Void, Error>? = nil)
    {
        self.writes.enqueue(
            data,
            lane: lane,
            continuation: continuation,
            write: { [self] data in try self.writePayload(data) },
            failed: { [weak self] error in self?.finish(error) })
    }

    private func writeNow(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        try self.writes.queue.sync { try self.writePayload(SidecarPayload(data)) }
    }

    private func writePayload(_ data: SidecarPayload) throws {
        let (input, frame) = try self.lock.withLock {
            guard self.phase == .preparing || self.phase == .running,
                  let input = self.input, let channel = self.channel
            else {
                throw self.failure ?? URLError(.cancelled)
            }
            return try (input, channel.seal(data))
        }
        try Self.writeExactly(frame, to: input)
    }

    private func deliver(_ data: Data) throws {
        self.lock.lock()
        guard self.failure == nil, self.taskState == .running else {
            let error = self.failure ?? URLError(.cancelled)
            self.lock.unlock()
            throw error
        }
        if !self.receivers.isEmpty {
            let receiver = self.receivers.removeFirst()
            self.lock.unlock()
            receiver.resume(returning: .data(data))
        } else {
            guard self.buffered.count < 256, self.bufferedBytes + data.count <= 64 * 1024 * 1024 else {
                self.lock.unlock()
                throw URLError(.dataLengthExceedsMaximum)
            }
            self.buffered.append(data)
            self.bufferedBytes += data.count
            self.lock.unlock()
        }
    }

    fileprivate static func _testRejectsDeliveryAfterFinish(_ data: Data) -> Bool {
        let task = RustGatewayWebSocketTask(
            executableURL: URL(fileURLWithPath: "/tmp/openclaw-rust-sidecar-test"))
        task.finish(URLError(.networkConnectionLost))
        do {
            try task.deliver(data)
            return false
        } catch {
            return true
        }
    }

    fileprivate func finish(_ error: Error) {
        self.lock.lock()
        guard self.failure == nil else { self.lock.unlock()
            return
        }
        self.failure = error
        self.phase = .completed
        self.admitted = false
        self.declaredCommands.removeAll()
        self.channel?.retire()
        let network = self.network
        self.network = nil
        let child = self.process
        let input = self.input
        let output = self.output
        let preparation = self.preparation
        self.preparation = nil
        self.process = nil
        self.input = nil
        self.output = nil
        let receivers = self.receivers
        let pings = self.pings.values
        self.receivers.removeAll()
        self.pings.removeAll()
        let retainedBuffered = (error as? URLError)?.code == .cancelled ? [] : self.buffered.filter {
            RustGatewayWebSocketSession.retainsBufferedFrameAfterFinish($0, connectID: self.connectID)
        }
        self.buffered = retainedBuffered
        self.bufferedBytes = retainedBuffered.reduce(0) { $0 + $1.count }
        self.lock.unlock()
        self.writes.close(error)
        network?.close()
        // Closing the owned pipe retires the Rust connection before any replacement process starts.
        // Closing on the writer queue prevents a reused descriptor from reaching a late write.
        self.writes.queue.async { try? input?.close() }
        self.reader.async { try? output?.close() }
        preparation?.resume(throwing: error)
        if let child, child.isRunning {
            child.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
                if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            }
        }
        for receiver in receivers {
            receiver.resume(throwing: error)
        }
        for ping in pings {
            ping(error)
        }
    }
}
