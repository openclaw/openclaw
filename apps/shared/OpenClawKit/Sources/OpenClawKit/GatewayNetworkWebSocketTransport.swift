import CryptoKit
import Foundation
import Network
import Security

final class GatewayNetworkWebSocketTask: WebSocketTasking, @unchecked Sendable {
    struct PendingPing {
        let payload: Data
        let handler: @Sendable (Error?) -> Void
    }

    struct State {
        var taskState: URLSessionTask.State = .suspended
        var ready = false
        var readyWaiters: [CheckedContinuation<Void, Error>] = []
        var receiveWaiters: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = []
        var receiveHandlers: [@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void] = []
        private var bufferedMessages: [(message: URLSessionWebSocketTask.Message, byteCount: Int)] = []
        private var bufferedMessageBytes = 0
        var pendingPings: [PendingPing] = []
        var readBuffer = Data()
        var fragmentedOpcode: UInt8?
        var fragmentedPayload = Data()
        var terminalError: Error?

        mutating func bufferMessage(_ message: URLSessionWebSocketTask.Message) throws {
            let byteCount: Int
            switch message {
            case let .data(data): byteCount = data.count
            case let .string(text): byteCount = text.utf8.count
            @unknown default: throw URLError(.cannotDecodeContentData)
            }
            guard self.bufferedMessages.count < 1024,
                  byteCount <= GatewayNetworkWebSocketTask.maximumMessageSize - self.bufferedMessageBytes
            else { throw URLError(.dataLengthExceedsMaximum) }
            self.bufferedMessages.append((message, byteCount))
            self.bufferedMessageBytes += byteCount
        }

        mutating func takeBufferedMessage() -> URLSessionWebSocketTask.Message? {
            guard !self.bufferedMessages.isEmpty else { return nil }
            let entry = self.bufferedMessages.removeFirst()
            self.bufferedMessageBytes -= entry.byteCount
            return entry.message
        }
    }

    enum FrameParseResult {
        case frame(opcode: UInt8, payload: Data)
        case consumed
        case incomplete
        case failure(Error)
    }

    static let maximumMessageSize = 16 * 1024 * 1024

    private let connection: NWConnection
    private let queue = DispatchQueue(label: "ai.openclaw.gateway.network-websocket")
    private let stateLock = NSLock()
    private var stateStorage = State()
    private let upgradeRequest: Data
    private let expectedAccept: String

    init(
        url: URL,
        host: String,
        port: NWEndpoint.Port,
        tlsServerName: String,
        headers: [String: String],
        trustEvaluator: @escaping @Sendable (SecTrust, String, Int) -> Bool)
    {
        let tlsOptions = NWProtocolTLS.Options()
        let securityOptions = tlsOptions.securityProtocolOptions
        tlsServerName.withCString {
            sec_protocol_options_set_tls_server_name(securityOptions, $0)
        }
        let verifyQueue = DispatchQueue(label: "ai.openclaw.gateway.network-websocket.tls")
        sec_protocol_options_set_verify_block(
            securityOptions,
            { _, trust, complete in
                let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
                complete(trustEvaluator(secTrust, tlsServerName, Int(port.rawValue)))
            },
            verifyQueue)

        let websocketKey = Self.websocketKey()
        self.expectedAccept = Self.websocketAccept(for: websocketKey)
        self.upgradeRequest = Self.makeUpgradeRequest(
            url: url,
            host: host,
            port: port,
            headers: headers,
            websocketKey: websocketKey)
        self.connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: port,
            using: NWParameters(tls: tlsOptions, tcp: NWProtocolTCP.Options()))
        self.connection.stateUpdateHandler = { [weak self] state in
            self?.handleConnectionState(state)
        }
    }

    var state: URLSessionTask.State {
        self.stateLock.withLock { self.stateStorage.taskState }
    }

    func resume() {
        let shouldStart = self.stateLock.withLock {
            guard self.stateStorage.taskState == .suspended else { return false }
            self.stateStorage.taskState = .running
            return true
        }
        guard shouldStart else { return }
        self.connection.start(queue: self.queue)
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        if self.state == .running {
            let code = closeCode == .goingAway ? UInt16(1001) : UInt16(1000)
            self.connection.send(
                content: Self.frame(opcode: 0x8, payload: Data([UInt8(code >> 8), UInt8(code & 0xFF)])),
                completion: .contentProcessed { _ in })
        }
        self.finish(URLError(.cancelled))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await self.waitUntilReady()
        let opcode: UInt8
        let payload: Data
        switch message {
        case let .data(data):
            opcode = 0x2
            payload = data
        case let .string(text):
            opcode = 0x1
            payload = Data(text.utf8)
        @unknown default:
            throw URLError(.unsupportedURL)
        }
        try await self.sendFrame(opcode: opcode, payload: payload)
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        let payload = Data(UUID().uuidString.utf8)
        let shouldSend = self.stateLock.withLock {
            if let error = self.stateStorage.terminalError {
                return Result<Bool, Error>.failure(error)
            }
            self.stateStorage.pendingPings.append(PendingPing(payload: payload, handler: pongReceiveHandler))
            return .success(self.stateStorage.ready)
        }
        switch shouldSend {
        case let .failure(error):
            pongReceiveHandler(error)
        case .success(true):
            self.sendPingFrame(payload: payload)
        case .success(false):
            break
        }
    }

    private func sendPingFrame(payload: Data) {
        self.connection.send(
            content: Self.frame(opcode: 0x9, payload: payload),
            completion: .contentProcessed { error in
                guard let error,
                      let handler = self.removePendingPing(payload: payload)
                else {
                    return
                }
                handler(error)
            })
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            self.enqueueReceive(continuation: continuation)
        }
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.enqueueReceive(handler: completionHandler)
    }

    private func handleConnectionState(_ state: NWConnection.State) {
        switch state {
        case .ready:
            self.sendUpgradeRequest()
        case let .failed(error):
            self.finish(error)
        case .cancelled:
            self.finish(URLError(.cancelled))
        default:
            break
        }
    }

    private func sendUpgradeRequest() {
        self.connection.send(content: self.upgradeRequest, completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            if let error {
                self.finish(error)
                return
            }
            self.readUpgradeResponse()
        })
    }

    private func readUpgradeResponse(buffer: Data = Data()) {
        self.connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: 4096)
        { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error {
                self.finish(error)
                return
            }
            var next = buffer
            if let data {
                next.append(data)
            }
            let headerEnd: Range<Data.Index>?
            do {
                headerEnd = try Self.upgradeHeaderEnd(in: next)
            } catch {
                self.finish(error)
                return
            }
            guard let headerEnd else {
                if isComplete {
                    self.finish(URLError(.networkConnectionLost))
                    return
                }
                self.readUpgradeResponse(buffer: next)
                return
            }
            let headers = String(data: next[..<headerEnd.upperBound], encoding: .utf8) ?? ""
            guard headers.hasPrefix("HTTP/1.1 101") || headers.hasPrefix("HTTP/1.0 101") else {
                self.finish(URLError(.badServerResponse))
                return
            }
            guard Self.responseHeaders(headers)["sec-websocket-accept"] == self.expectedAccept else {
                self.finish(URLError(.badServerResponse))
                return
            }
            self.markReady()
            let remainder = next[headerEnd.upperBound...]
            if !remainder.isEmpty {
                self.stateLock.withLock {
                    self.stateStorage.readBuffer.append(remainder)
                }
                self.parseBufferedFrames()
            }
            if isComplete {
                self.finish(URLError(.networkConnectionLost))
                return
            }
            self.receiveBytes()
        }
    }

    private func receiveBytes() {
        self.connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: 64 * 1024)
        { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error {
                self.finish(error)
                return
            }
            if let data, !data.isEmpty {
                self.stateLock.withLock {
                    self.stateStorage.readBuffer.append(data)
                }
                self.parseBufferedFrames()
            }
            if isComplete {
                self.finish(URLError(.networkConnectionLost))
                return
            }
            guard self.state == .running else { return }
            self.receiveBytes()
        }
    }

    private func waitUntilReady() async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.stateLock.lock()
            if self.stateStorage.ready {
                self.stateLock.unlock()
                ThrowingContinuationSupport.resumeVoid(continuation, error: nil)
                return
            }
            if let error = self.stateStorage.terminalError {
                self.stateLock.unlock()
                ThrowingContinuationSupport.resumeVoid(continuation, error: error)
                return
            }
            self.stateStorage.readyWaiters.append(continuation)
            self.stateLock.unlock()
        }
    }

    private func sendFrame(opcode: UInt8, payload: Data) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.connection.send(
                content: Self.frame(opcode: opcode, payload: payload),
                completion: .contentProcessed { error in
                    ThrowingContinuationSupport.resumeVoid(continuation, error: error)
                })
        }
    }

    private func markReady() {
        let (waiters, queuedPings) = self.stateLock.withLock {
            self.stateStorage.ready = true
            let waiters = self.stateStorage.readyWaiters
            self.stateStorage.readyWaiters.removeAll()
            return (waiters, self.stateStorage.pendingPings.map(\.payload))
        }
        for waiter in waiters {
            ThrowingContinuationSupport.resumeVoid(waiter, error: nil)
        }
        for payload in queuedPings {
            self.sendPingFrame(payload: payload)
        }
    }

    private func enqueueReceive(continuation: CheckedContinuation<URLSessionWebSocketTask.Message, Error>) {
        self.stateLock.lock()
        if let message = self.stateStorage.takeBufferedMessage() {
            self.stateLock.unlock()
            continuation.resume(returning: message)
            return
        }
        if let error = self.stateStorage.terminalError {
            self.stateLock.unlock()
            continuation.resume(throwing: error)
            return
        }
        self.stateStorage.receiveWaiters.append(continuation)
        self.stateLock.unlock()
    }

    private func enqueueReceive(
        handler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.stateLock.lock()
        if let message = self.stateStorage.takeBufferedMessage() {
            self.stateLock.unlock()
            handler(.success(message))
            return
        }
        if let error = self.stateStorage.terminalError {
            self.stateLock.unlock()
            handler(.failure(error))
            return
        }
        self.stateStorage.receiveHandlers.append(handler)
        self.stateLock.unlock()
    }

    private func parseBufferedFrames() {
        let result = self.stateLock.withLock {
            Self.drainFrames(from: &self.stateStorage)
        }
        switch result {
        case let .success(frames):
            for frame in frames {
                guard self.state == .running else { return }
                self.handleFrame(opcode: frame.opcode, payload: frame.payload)
            }
        case let .failure(error):
            self.finish(error)
        }
    }

    private func handleFrame(opcode: UInt8, payload: Data) {
        switch opcode {
        case 0x1:
            self.deliver(.string(String(data: payload, encoding: .utf8) ?? ""))
        case 0x2:
            self.deliver(.data(payload))
        case 0x8:
            self.finish(URLError(.networkConnectionLost))
        case 0x9:
            self.connection.send(
                content: Self.frame(opcode: 0xA, payload: payload),
                completion: .contentProcessed { _ in })
        case 0xA:
            let handler = self.removePendingPing(payload: payload)
            handler?(nil)
        default:
            break
        }
    }

    private func removePendingPing(payload: Data) -> (@Sendable (Error?) -> Void)? {
        self.stateLock.withLock {
            guard let index = self.stateStorage.pendingPings.firstIndex(where: { $0.payload == payload }) else {
                return nil
            }
            return self.stateStorage.pendingPings.remove(at: index).handler
        }
    }

    private func deliver(_ message: URLSessionWebSocketTask.Message) {
        typealias Delivery = (
            CheckedContinuation<URLSessionWebSocketTask.Message, Error>?,
            (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?)
        do {
            let delivery: Delivery = try self.stateLock.withLock {
                guard self.stateStorage.terminalError == nil else { return (nil, nil) }
                if !self.stateStorage.receiveWaiters.isEmpty {
                    return (self.stateStorage.receiveWaiters.removeFirst(), nil)
                }
                if !self.stateStorage.receiveHandlers.isEmpty {
                    return (nil, self.stateStorage.receiveHandlers.removeFirst())
                }
                try self.stateStorage.bufferMessage(message)
                return (nil, nil)
            }
            delivery.0?.resume(returning: message)
            delivery.1?(.success(message))
        } catch {
            self.finish(error)
        }
    }

    private func finish(_ error: Error) {
        let drained = self.stateLock.withLock {
            guard self.stateStorage.terminalError == nil else {
                return (
                    [CheckedContinuation<Void, Error>](),
                    [CheckedContinuation<URLSessionWebSocketTask.Message, Error>](),
                    [@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void](),
                    [PendingPing]())
            }
            self.stateStorage.taskState = .completed
            self.stateStorage.terminalError = error
            let ready = self.stateStorage.readyWaiters
            let receives = self.stateStorage.receiveWaiters
            let handlers = self.stateStorage.receiveHandlers
            let pings = self.stateStorage.pendingPings
            self.stateStorage.readyWaiters.removeAll()
            self.stateStorage.receiveWaiters.removeAll()
            self.stateStorage.receiveHandlers.removeAll()
            self.stateStorage.pendingPings.removeAll()
            return (ready, receives, handlers, pings)
        }
        self.connection.cancel()
        for waiter in drained.0 {
            ThrowingContinuationSupport.resumeVoid(waiter, error: error)
        }
        for waiter in drained.1 {
            waiter.resume(throwing: error)
        }
        for handler in drained.2 {
            handler(.failure(error))
        }
        for ping in drained.3 {
            ping.handler(error)
        }
    }

    static func makeUpgradeRequest(
        url: URL,
        host: String,
        port: NWEndpoint.Port,
        headers: [String: String],
        websocketKey: String) -> Data
    {
        var fields = headers.filter {
            $0.key.caseInsensitiveCompare("Host") != .orderedSame
        }
        fields["Host"] = Self.hostHeaderValue(from: headers, fallback: Self.hostHeader(host: host, port: port))
        fields["Upgrade"] = "websocket"
        fields["Connection"] = "Upgrade"
        fields["Sec-WebSocket-Version"] = "13"
        fields["Sec-WebSocket-Key"] = websocketKey
        var lines = ["GET \(Self.requestPath(url)) HTTP/1.1"]
        lines.append(contentsOf: fields.map { "\($0.key): \($0.value)" }.sorted())
        lines.append("")
        lines.append("")
        return Data(lines.joined(separator: "\r\n").utf8)
    }

    static func upgradeHeaderEnd(in buffer: Data) throws -> Range<Data.Index>? {
        let end = buffer.range(of: Data("\r\n\r\n".utf8))
        // Bytes after the header terminator may already contain WebSocket frames.
        let headerBytes = end.map { buffer.distance(from: buffer.startIndex, to: $0.upperBound) }
            ?? buffer.count
        guard headerBytes <= 64 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
        return end
    }

    static func responseHeaders(_ response: String) -> [String: String] {
        var fields: [String: String] = [:]
        for line in response.split(separator: "\r\n").dropFirst() {
            guard let separator = line.firstIndex(of: ":") else { continue }
            let name = line[..<separator].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespacesAndNewlines)
            fields[name] = value
        }
        return fields
    }

    static func requestPath(_ url: URL) -> String {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var path = components?.percentEncodedPath ?? ""
        if path.isEmpty {
            path = "/"
        }
        if let query = components?.percentEncodedQuery, !query.isEmpty {
            path += "?\(query)"
        }
        return path
    }

    static func hostHeader(host: String, port: NWEndpoint.Port) -> String {
        let wrappedHost = host.contains(":") ? "[\(host)]" : host
        return port.rawValue == 443 ? wrappedHost : "\(wrappedHost):\(port.rawValue)"
    }

    static func hostHeaderValue(from headers: [String: String], fallback: String) -> String {
        headers.first {
            $0.key.caseInsensitiveCompare("Host") == .orderedSame
        }?.value ?? fallback
    }

    private static func websocketKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
    }

    private static func websocketAccept(for key: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
        return Data(digest).base64EncodedString()
    }

    static func frame(opcode: UInt8, payload: Data) -> Data {
        var frame = Data([0x80 | opcode])
        let count = payload.count
        if count <= 125 {
            frame.append(0x80 | UInt8(count))
        } else if count <= Int(UInt16.max) {
            frame.append(0x80 | 126)
            frame.append(UInt8((count >> 8) & 0xFF))
            frame.append(UInt8(count & 0xFF))
        } else {
            frame.append(0x80 | 127)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((UInt64(count) >> UInt64(shift)) & 0xFF))
            }
        }
        var mask = [UInt8](repeating: 0, count: 4)
        _ = SecRandomCopyBytes(kSecRandomDefault, mask.count, &mask)
        frame.append(contentsOf: mask)
        for (index, byte) in payload.enumerated() {
            frame.append(byte ^ mask[index % 4])
        }
        return frame
    }

    static func drainFrames(from state: inout State) -> Result<[(opcode: UInt8, payload: Data)], Error> {
        var frames: [(opcode: UInt8, payload: Data)] = []
        while true {
            switch Self.nextFrame(from: &state) {
            case let .frame(opcode, payload):
                frames.append((opcode, payload))
            case .consumed:
                continue
            case .incomplete:
                return .success(frames)
            case let .failure(error):
                return .failure(error)
            }
        }
    }

    static func nextFrame(from state: inout State) -> FrameParseResult {
        guard state.readBuffer.count >= 2 else { return .incomplete }
        let bytes = [UInt8](state.readBuffer.prefix(14))
        let first = bytes[0]
        let second = bytes[1]
        let masked = (second & 0x80) != 0
        var offset = 2
        var length = Int(second & 0x7F)
        if length == 126 {
            guard state.readBuffer.count >= 4 else { return .incomplete }
            length = (Int(bytes[2]) << 8) | Int(bytes[3])
            offset = 4
        } else if length == 127 {
            guard state.readBuffer.count >= 10 else { return .incomplete }
            var value: UInt64 = 0
            for byte in bytes[2..<10] {
                value = (value << 8) | UInt64(byte)
            }
            guard value <= UInt64(Int.max) else { return .failure(URLError(.dataLengthExceedsMaximum)) }
            length = Int(value)
            offset = 10
        }
        guard length <= Self.maximumMessageSize else {
            return .failure(URLError(.dataLengthExceedsMaximum))
        }
        let maskOffset = offset
        if masked {
            offset += 4
        }
        guard length <= Int.max - offset else { return .failure(URLError(.dataLengthExceedsMaximum)) }
        let frameLength = offset + length
        guard state.readBuffer.count >= frameLength else { return .incomplete }
        let payloadStart = state.readBuffer.index(state.readBuffer.startIndex, offsetBy: offset)
        let payloadEnd = state.readBuffer.index(payloadStart, offsetBy: length)
        var payload = Data(state.readBuffer[payloadStart..<payloadEnd])
        if masked {
            let maskStart = state.readBuffer.index(state.readBuffer.startIndex, offsetBy: maskOffset)
            let maskEnd = state.readBuffer.index(maskStart, offsetBy: 4)
            let mask = [UInt8](state.readBuffer[maskStart..<maskEnd])
            payload = Data(payload.enumerated().map { index, byte in
                byte ^ mask[index % 4]
            })
        }
        state.readBuffer.removeFirst(frameLength)
        let opcode = first & 0x0F
        let fin = (first & 0x80) != 0
        if opcode == 0x0 {
            guard payload.count <= Self.maximumMessageSize - state.fragmentedPayload.count else {
                return .failure(URLError(.dataLengthExceedsMaximum))
            }
            state.fragmentedPayload.append(payload)
            guard fin, let fragmentedOpcode = state.fragmentedOpcode else { return .consumed }
            let complete = state.fragmentedPayload
            state.fragmentedOpcode = nil
            state.fragmentedPayload = Data()
            return .frame(opcode: fragmentedOpcode, payload: complete)
        }
        if !fin, opcode == 0x1 || opcode == 0x2 {
            state.fragmentedOpcode = opcode
            state.fragmentedPayload = payload
            return .consumed
        }
        return .frame(opcode: opcode, payload: payload)
    }
}

extension NSLock {
    fileprivate func withLock<T>(_ body: () throws -> T) rethrows -> T {
        self.lock()
        defer { self.unlock() }
        return try body()
    }
}
