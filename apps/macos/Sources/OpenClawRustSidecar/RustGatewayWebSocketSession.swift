import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import Security

/// A product-owned process transport. Gateway credentials still come from the native auth owner.
package final class RustGatewayWebSocketSession: WebSocketSessioning, GatewayTLSRouteMetadataProviding,
GatewayTLSFailureProviding, GatewayDeviceTokenRetryTrustProviding, @unchecked Sendable {
    private let executableURL: URL
    private let fingerprint: String?
    private let trustOwner: GatewayTLSPinningSession

    package static var bundledExecutableURL: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/openclaw-mac-node-sidecar")
    }

    package static func _testRetainsBufferedFrameAfterFinish(_ data: Data, connectID: String?) -> Bool {
        self.retainsBufferedFrameAfterFinish(data, connectID: connectID)
    }

    package static func _testRejectsDeliveryAfterFinish(_ data: Data) -> Bool {
        RustGatewayWebSocketTask._testRejectsDeliveryAfterFinish(data)
    }

    package static func _testConnectMetadata(_ data: Data) -> (id: String?, commands: Set<String>)? {
        guard let frame = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return self.connectMetadata(frame)
    }

    fileprivate static func connectMetadata(_ frame: Any) -> (id: String?, commands: Set<String>)? {
        guard let request = frame as? [String: Any], request["method"] as? String == "connect" else {
            return nil
        }
        let params = request["params"] as? [String: Any]
        return (request["id"] as? String, Set(params?["commands"] as? [String] ?? []))
    }

    package init(executableURL: URL, fingerprint: String? = nil, tlsParams: GatewayTLSParams? = nil) {
        self.executableURL = executableURL
        self.fingerprint = fingerprint
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
        WebSocketTaskBox(task: RustGatewayWebSocketTask(
            executableURL: self.executableURL,
            request: request,
            fingerprint: self.fingerprint,
            trustOwner: self.trustOwner))
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
    private let lock = NSLock()
    private let writer = DispatchQueue(label: "ai.openclaw.sidecar.write")
    private let reader = DispatchQueue(label: "ai.openclaw.sidecar.read")
    private let executableURL: URL
    private let request: URLRequest
    private let fingerprint: String?
    private let trustOwner: GatewayTLSPinningSession
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var channel: AuthenticatedSidecarChannel?
    private var taskState: URLSessionTask.State = .suspended
    private var failure: Error?
    private var buffered: [Data] = []
    private var bufferedBytes = 0
    private var queuedWrites = 0
    private var queuedWriteBytes = 0
    private var receivers: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = []
    private var pings: [String: @Sendable (Error?) -> Void] = [:]
    private var declaredCommands = Set<String>()
    private var connectID: String?
    private var admitted = false

    init(executableURL: URL, request: URLRequest, fingerprint: String?, trustOwner: GatewayTLSPinningSession) {
        self.executableURL = executableURL
        self.request = request
        self.fingerprint = fingerprint
        self.trustOwner = trustOwner
    }

    var state: URLSessionTask.State {
        self.lock.withLock { self.taskState }
    }

    func resume() {
        let start = self.lock.withLock {
            guard self.taskState == .suspended else { return false }
            self.taskState = .running
            return true
        }
        guard start else { return }
        self.reader.async { [self] in
            do { try self.run() } catch { self.finish(error) }
        }
    }

    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
        self.finish(URLError(.cancelled))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await self.send(message, lifetime: nil)
    }

    func sendRequest(_ message: URLSessionWebSocketTask.Message, lifetime: WebSocketRequestLifetime) async throws {
        try await self.send(message, lifetime: lifetime)
    }

    private func send(_ message: URLSessionWebSocketTask.Message, lifetime: WebSocketRequestLifetime?) async throws {
        let data: Data
        switch message {
        case let .data(value): data = value
        case let .string(value): data = Data(value.utf8)
        @unknown default: throw URLError(.unknown)
        }
        let frame = try JSONSerialization.jsonObject(with: data)
        if let metadata = RustGatewayWebSocketSession.connectMetadata(frame) {
            self.lock.withLock {
                self.declaredCommands = metadata.commands
                self.connectID = metadata.id
            }
        }
        let payload = try JSONSerialization.data(withJSONObject: [
            "type": "frame", "frame": frame, "callerOwnsLifetime": lifetime != nil,
        ])
        guard let lifetime else {
            try await self.write(payload)
            return
        }
        guard let request = frame as? [String: Any], let id = request["id"] as? String else {
            throw URLError(.cannotParseResponse)
        }
        let cancellation = try JSONSerialization.data(withJSONObject: ["type": "cancel-request", "id": id])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let active = lifetime.performIfActive {
                self.enqueueWrite(payload, continuation: continuation)
            } onFinish: { [weak self] in
                self?.enqueueWrite(cancellation)
            }
            if !active { continuation.resume(throwing: CancellationError()) }
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
            do { try await self.write(["type": "ping", "id": id]) } catch { self.finish(error) }
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

    private func run() throws {
        guard FileManager.default.isExecutableFile(atPath: self.executableURL.path) else {
            throw Self.startupError(3, "The macOS node runtime helper is missing or not executable.")
        }
        if self.executableURL == RustGatewayWebSocketSession.bundledExecutableURL {
            try Self.verifyBundledArtifact()
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
        try child.run()
        try stdinPipe.fileHandleForReading.close()
        try stdoutPipe.fileHandleForWriting.close()
        let installed = self.lock.withLock {
            guard self.taskState == .running else { return false }
            self.process = child
            self.input = stdinPipe.fileHandleForWriting
            self.output = stdoutPipe.fileHandleForReading
            return true
        }
        guard installed else { child.terminate()
            return
        }
        defer { try? stdoutPipe.fileHandleForReading.close() }
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
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let sessionBytes = SymmetricKey(size: .bits128).withUnsafeBytes { Data($0) }
        let sessionID = sessionBytes.map { String(format: "%02x", $0) }.joined()
        let channel = try AuthenticatedSidecarChannel(key: key, sessionID: sessionID, generation: 1)
        try self.lock.withLock {
            guard self.taskState == .running else { throw URLError(.cancelled) }
            self.channel = channel
        }
        var bootstrap = key + sessionBytes
        bootstrap.append(contentsOf: [0, 0, 0, 0, 0, 0, 0, 1])
        try self.writer.sync { try Self.writeExactly(bootstrap, to: stdinPipe.fileHandleForWriting) }
        bootstrap.resetBytes(in: bootstrap.startIndex..<bootstrap.endIndex)
        let limits: [String: Any] = ["maxFrameBytes": 16_777_216, "maxInFlight": 64, "bootstrapTimeoutMs": 10000]
        let offer: [String: Any] = [
            "protocolMajor": 1, "protocolMinor": 0, "featureBits": 0, "limits": limits,
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
            acceptance = try self.readMessage(stdoutPipe.fileHandleForReading, bootstrap: true)
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
              selection["featureBits"] as? Int == 0,
              let selectedLimits = selection["limits"] as? [String: Int],
              selectedLimits["maxFrameBytes"] == min(remoteLimits["maxFrameBytes"] ?? 0, 16_777_216),
              selectedLimits["maxInFlight"] == min(remoteLimits["maxInFlight"] ?? 0, 64),
              selectedLimits["bootstrapTimeoutMs"] == min(remoteLimits["bootstrapTimeoutMs"] ?? 0, 10000),
              (selectedLimits["maxInFlight"] ?? 0) > 0,
              (selectedLimits["bootstrapTimeoutMs"] ?? 0) > 0,
              let frameLimit = selectedLimits["maxFrameBytes"]
        else { throw Self.startupError(4, "The macOS node runtime helper protocol is incompatible.") }
        try self.lock.withLock {
            try channel.lowerFrameLimit(frameLimit)
            channel.lockFrameLimit()
        }
        guard let url = self.request.url else { throw URLError(.badURL) }
        var open: [String: Any] = [
            "type": "open",
            "url": url.absoluteString,
            "headers": self.request.allHTTPHeaderFields ?? [:],
            "native_tls": url.scheme?.lowercased() == "wss",
        ]
        if let fingerprint = self.fingerprint { open["fingerprint"] = fingerprint }
        try self.writeNow(open)
        while self.state == .running {
            try autoreleasepool {
                let message = try self.readMessage(stdoutPipe.fileHandleForReading)
                try self.handle(message, url: url)
            }
        }
    }

    private func handle(_ message: [String: Any], url: URL) throws {
        switch message["type"] as? String {
        case "tls-peer":
            let allowed = try self.evaluateTLS(message, url: url)
            try self.writeNow(["type": "tls-decision", "allowed": allowed])
            if !allowed { throw URLError(.serverCertificateUntrusted) }
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
                self.admitted && self.taskState == .running && self.declaredCommands.contains(command)
            }
            try self.writeNow(["type": "admission", "id": id, "allowed": allowed])
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

    private func evaluateTLS(_ message: [String: Any], url: URL) throws -> Bool {
        guard let authority = GatewayTLSAuthority(url: url),
              let host = message["serverName"] as? String,
              let port = message["port"] as? Int,
              authority.matches(host: host, port: port),
              let encoded = message["certificateChain"] as? [String], !encoded.isEmpty,
              encoded.count <= 16
        else { throw URLError(.cannotParseResponse) }
        let certificates = try encoded.map { encoded -> SecCertificate in
            guard let data = Data(base64Encoded: encoded), data.count <= 1024 * 1024,
                  let certificate = SecCertificateCreateWithData(nil, data as CFData)
            else { throw URLError(.cannotParseResponse) }
            return certificate
        }
        var trust: SecTrust?
        let status = SecTrustCreateWithCertificates(
            certificates as CFArray, SecPolicyCreateSSL(true, authority.host as CFString), &trust)
        guard status == errSecSuccess, let trust else { throw URLError(.serverCertificateUntrusted) }
        if let encodedOCSP = message["ocspResponse"] as? String, !encodedOCSP.isEmpty {
            guard let ocsp = Data(base64Encoded: encodedOCSP) else { throw URLError(.cannotParseResponse) }
            guard SecTrustSetOCSPResponse(trust, ocsp as CFData) == errSecSuccess else {
                throw URLError(.serverCertificateUntrusted)
            }
        }
        guard self.state == .running else { throw URLError(.cancelled) }
        return self.trustOwner.validateServerTrust(trust, for: url)
    }

    private func readMessage(_ handle: FileHandle, bootstrap: Bool = false) throws -> [String: Any] {
        let prefix = try Self.readExactly(4, from: handle, bounded: bootstrap)
        let count = prefix.reduce(0) { ($0 << 8) | Int($1) }
        guard count >= 65, count <= self.lock.withLock({ self.channel?.maxFrameBytes ?? 0 }) else {
            throw URLError(.dataLengthExceedsMaximum)
        }
        let frame = try Self.readExactly(count, from: handle, bounded: true)
        let data = try self.lock.withLock {
            guard let channel = self.channel else { throw URLError(.cancelled) }
            return try channel.open(frame)
        }
        guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        return message
    }

    /// The bundle seal covers this exact helper; verify immediately before handing it session keys.
    private static func verifyBundledArtifact() throws {
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
        for url in [Bundle.main.bundleURL, RustGatewayWebSocketSession.bundledExecutableURL] {
            var code: SecStaticCode?
            guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess,
                  let code, SecStaticCodeCheckValidity(code, flags, nil) == errSecSuccess
            else {
                throw NSError(domain: "OpenClawRustSidecar", code: 2, userInfo: [
                    NSLocalizedDescriptionKey:
                        "The bundled node runtime failed signature verification. Reinstall the signed app.",
                ])
            }
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

    private static func readExactly(_ count: Int, from handle: FileHandle, bounded: Bool) throws -> Data {
        let deadline = bounded ? DispatchTime.now().uptimeNanoseconds + 10_000_000_000 : nil
        let descriptor = handle.fileDescriptor
        var data = Data(count: count)
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
        return data
    }

    private static func writeExactly(_ data: Data, to handle: FileHandle) throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        let descriptor = handle.fileDescriptor
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

    private func write(_ value: [String: Any]) async throws {
        try await self.write(JSONSerialization.data(withJSONObject: value))
    }

    private func write(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.enqueueWrite(data, continuation: continuation)
        }
    }

    private func enqueueWrite(_ data: Data, continuation: CheckedContinuation<Void, Error>? = nil) {
        let accepted = self.lock.withLock {
            guard self.taskState == .running, self.queuedWrites < 64,
                  self.queuedWriteBytes + data.count <= 64 * 1024 * 1024
            else { return false }
            self.queuedWrites += 1
            self.queuedWriteBytes += data.count
            return true
        }
        guard accepted else {
            let error: any Error = self.lock.withLock { self.failure ?? URLError(.dataLengthExceedsMaximum) }
            self.finish(error)
            continuation?.resume(throwing: error)
            return
        }
        self.writer.async {
            defer {
                self.lock.withLock {
                    self.queuedWrites -= 1
                    self.queuedWriteBytes -= data.count
                }
            }
            do {
                try self.writePayload(data)
                continuation?.resume()
            } catch {
                self.finish(error)
                continuation?.resume(throwing: error)
            }
        }
    }

    private func writeNow(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        try self.writer.sync { try self.writePayload(data) }
    }

    private func writePayload(_ data: Data) throws {
        let (input, frame) = try self.lock.withLock {
            guard self.taskState == .running, let input = self.input, let channel = self.channel else {
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
            executableURL: URL(fileURLWithPath: "/tmp/openclaw-rust-sidecar-test"),
            request: URLRequest(url: URL(string: "ws://127.0.0.1:1")!),
            fingerprint: nil,
            trustOwner: GatewayTLSPinningSession(params: GatewayTLSParams(
                required: false, expectedFingerprint: nil, allowTOFU: false, storeKey: nil)))
        task.finish(URLError(.networkConnectionLost))
        do {
            try task.deliver(data)
            return false
        } catch {
            return true
        }
    }

    private func finish(_ error: Error) {
        self.lock.lock()
        guard self.failure == nil else { self.lock.unlock()
            return
        }
        self.failure = error
        self.taskState = .completed
        self.admitted = false
        self.declaredCommands.removeAll()
        self.channel?.retire()
        let child = self.process
        let input = self.input
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
        // Closing the owned pipe retires the Rust connection before any replacement process starts.
        // Closing on the writer queue prevents a reused descriptor from reaching a late write.
        self.writer.async { try? input?.close() }
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
