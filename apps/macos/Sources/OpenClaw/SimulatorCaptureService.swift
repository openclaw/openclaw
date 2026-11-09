import Foundation
import ImageIO
import OpenClawKit

/// The Simulator framebuffer and HID client belong to the same desktop execution.
/// Neither child may survive a closed or revoked execution.
@MainActor
final class SimulatorCaptureService {
    enum CaptureError: LocalizedError {
        case busy
        case noDevice
        case multipleDevices
        case staleSession
        case unavailable(String)
        case invalidInput

        var errorDescription: String? {
            switch self {
            case .busy: "Simulator is already open in another preview. Close it before retrying."
            case .noDevice: "Boot an iOS Simulator, then reopen the preview."
            case .multipleDevices: "More than one iOS Simulator is booted. Shut down the extra device and retry."
            case .staleSession: "Simulator preview ended; reopen it to continue."
            case let .unavailable(reason): "Simulator helper stopped: \(reason). Reopen the preview."
            case .invalidInput: "Simulator input is invalid or unsupported."
            }
        }
    }

    struct Frame: Encodable {
        let sessionId: String
        let sequence: UInt64
        let jpegBase64: String?
        let width: Int
        let height: Int
    }

    private var sessionId: String?
    private var executionId: String?
    private var reservationId: UUID?
    private var captureProcess: Process?
    private var touchProcess: Process?
    private var capturePipe: Pipe?
    private var captureErrorPipe: Pipe?
    private var touchErrorPipe: Pipe?
    private var touchAckPipe: Pipe?
    private var touchInputPipe: Pipe?
    private var deviceUDID: String?
    private var frames: SimulatorFrameBuffer?
    private var touchReady: SimulatorTouchReadiness?
    private var lastRead = Date.distantPast
    private var expiry: Task<Void, Never>?
    private var inputInProgress = false
    private var heldTouch = false
    private var pasteboardTransaction: Task<Void, Error>?
    private var stopTask: Task<Void, Never>?

    func start(executionId: String) async throws -> Frame {
        guard self.reservationId == nil, self.stopTask == nil else { throw CaptureError.busy }
        let reservation = UUID()
        self.reservationId = reservation
        self.executionId = executionId
        do {
            let udid = try await Self.bootedIOSDevice()
            guard self.reservationId == reservation else { throw CaptureError.staleSession }
            self.deviceUDID = udid
            let captureOutput = SimulatorFrameBuffer()
            let touchOutput = SimulatorTouchReadiness()
            let capture = try Self.helper("openclaw-simulator-capture", arguments: ["12", udid, "jpeg"])
            var environment = ProcessInfo.processInfo.environment
            environment["TAPFLOW_IOS_MAX_SIZE"] = "1400"
            capture.environment = environment
            let capturePipe = Pipe()
            let captureErrorPipe = Pipe()
            capture.standardOutput = capturePipe
            capture.standardError = captureErrorPipe
            capturePipe.fileHandleForReading.readabilityHandler = { handle in
                captureOutput.append(handle.availableData)
            }
            captureErrorPipe.fileHandleForReading.readabilityHandler = { handle in
                captureOutput.appendError(handle.availableData)
            }
            capture.terminationHandler = { process in
                captureOutput.stop("capture exited with status \(process.terminationStatus)")
            }
            try capture.run()
            self.captureProcess = capture
            self.capturePipe = capturePipe
            self.captureErrorPipe = captureErrorPipe
            self.frames = captureOutput

            let touch = try Self.helper("openclaw-simulator-touch", arguments: [udid])
            let touchInputPipe = Pipe()
            let touchErrorPipe = Pipe()
            let touchAckPipe = Pipe()
            touch.standardInput = touchInputPipe
            touch.standardError = touchErrorPipe
            touch.standardOutput = touchAckPipe
            touchErrorPipe.fileHandleForReading.readabilityHandler = { handle in
                touchOutput.append(handle.availableData)
            }
            touchAckPipe.fileHandleForReading.readabilityHandler = { handle in
                touchOutput.appendAck(handle.availableData)
            }
            touch.terminationHandler = { process in
                touchOutput.stop("input exited with status \(process.terminationStatus)")
            }
            try touch.run()
            self.touchProcess = touch
            self.touchInputPipe = touchInputPipe
            self.touchErrorPipe = touchErrorPipe
            self.touchAckPipe = touchAckPipe
            self.touchReady = touchOutput

            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                guard self.reservationId == reservation else { throw CaptureError.staleSession }
                if let failure = captureOutput.failure ?? touchOutput.failure {
                    throw CaptureError.unavailable(failure)
                }
                if touchOutput.ready, let frame = captureOutput.latest {
                    let sessionId = UUID().uuidString
                    self.sessionId = sessionId
                    self.lastRead = Date()
                    self.expiry = Task { [weak self] in
                        while !Task.isCancelled {
                            try? await Task.sleep(for: .seconds(5))
                            guard let self, !Task.isCancelled else { return }
                            if Date().timeIntervalSince(self.lastRead) > 15 {
                                await self.stop()
                                return
                            }
                        }
                    }
                    return Frame(sessionId: sessionId, sequence: frame.sequence,
                                 jpegBase64: frame.jpeg.base64EncodedString(),
                                 width: frame.width, height: frame.height)
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw CaptureError.unavailable("no device frame or HID ready signal within 5 seconds")
        } catch {
            if self.reservationId == reservation { await self.stop() }
            throw error
        }
    }

    func read(sessionId: String, after sequence: UInt64) throws -> Frame {
        guard self.sessionId == sessionId, let frames, let touchReady else { throw CaptureError.staleSession }
        if let failure = frames.failure ?? touchReady.failure { throw CaptureError.unavailable(failure) }
        guard self.captureProcess?.isRunning == true else {
            throw CaptureError.unavailable("device capture ended")
        }
        guard let latest = frames.latest else { throw CaptureError.unavailable("device frame unavailable") }
        guard latest.isFresh(at: Date()) else {
            throw CaptureError.unavailable("device frames stopped arriving")
        }
        self.lastRead = Date()
        return Frame(sessionId: sessionId, sequence: latest.sequence,
                     jpegBase64: latest.sequence > sequence ? latest.jpeg.base64EncodedString() : nil,
                     width: latest.width, height: latest.height)
    }

    func input(
        sessionId: String, action: OpenClawComputerAction,
        x: Double?, y: Double?, fromX: Double?, fromY: Double?,
        text: String?, keys: String?, validate: @escaping () throws -> Void) async throws
    {
        guard self.sessionId == sessionId, !self.inputInProgress,
              self.touchReady?.ready == true, self.touchReady?.failure == nil,
              let pipe = self.touchInputPipe else { throw CaptureError.staleSession }
        try self.requireHealthyCapture(sessionId: sessionId)
        self.inputInProgress = true
        defer { self.inputInProgress = false }
        func point(_ x: Double?, _ y: Double?) throws -> (Float, Float) {
            guard let x, let y, x.isFinite, y.isFinite,
                  (0...1).contains(x), (0...1).contains(y) else { throw CaptureError.invalidInput }
            return (Float(x), Float(y))
        }
        func write(_ data: Data) throws {
            try validate()
            try self.requireHealthyCapture(sessionId: sessionId)
            guard self.sessionId == sessionId, self.touchProcess?.isRunning == true else {
                throw CaptureError.staleSession
            }
            try pipe.fileHandleForWriting.write(contentsOf: data)
        }
        func touch(_ kind: UInt8, _ point: (Float, Float)) throws {
            var data = Data([kind])
            for value in [point.0, point.1] {
                var bits = value.bitPattern.bigEndian
                withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
            }
            try write(data)
            if kind == 1 { self.heldTouch = true }
            if kind == 3 || kind == 13 { self.heldTouch = false }
        }
        func key(_ usage: UInt32, modifiers: UInt8 = 0) throws {
            var data = Data([9, modifiers, 0, 0, 0])
            var bits = usage.bigEndian
            withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
            try write(data)
        }
        switch action {
        case .leftClick:
            let target = try point(x, y)
            try touch(1, target)
            do {
                try await Task.sleep(for: .milliseconds(60))
                try touch(3, target)
            } catch {
                self.cancelHeldTouch(sessionId: sessionId)
                throw error
            }
        case .leftClickDrag:
            let origin = try point(fromX, fromY)
            let target = try point(x, y)
            try touch(1, origin)
            do {
                for step in 1...12 {
                    try await Task.sleep(for: .milliseconds(20))
                    let fraction = Float(step) / 12
                    try touch(2, (origin.0 + (target.0 - origin.0) * fraction,
                                  origin.1 + (target.1 - origin.1) * fraction))
                }
                try touch(3, target)
            } catch {
                self.cancelHeldTouch(sessionId: sessionId)
                throw error
            }
        case .key:
            if keys == "HOME" {
                try write(Data([5, 0, 0, 0, 0, 0, 0, 0, 0]))
                return
            }
            let mapping: [String: UInt32] = [
                "RETURN": 0x28, "ENTER": 0x28, "ESCAPE": 0x29, "BACKSPACE": 0x2A,
                "TAB": 0x2B, "RIGHT": 0x4F, "LEFT": 0x50, "DOWN": 0x51, "UP": 0x52,
            ]
            guard let keys, let usage = mapping[keys] else { throw CaptureError.invalidInput }
            try key(usage)
        case .type:
            guard let text, !text.isEmpty, text.utf8.count <= 4096,
                  let udid = self.deviceUDID else { throw CaptureError.invalidInput }
            // Keep the device pasteboard private to this input. The HID chord uses
            // the same exact device as capture; restore even if control is revoked.
            let before = try await Self.pasteboard("pbpaste", udid: udid)
            try validate()
            guard self.sessionId == sessionId else { throw CaptureError.staleSession }
            // Own the entire write/restore transaction before its first suspension.
            // Closing the execution waits for this task before it acknowledges revoke.
            let transaction = Task { @MainActor in
                var inputError: Error?
                do {
                    _ = try await Self.pasteboard("pbcopy", udid: udid, input: Data(text.utf8))
                    try key(0x19, modifiers: 0x08)
                    try await Task.sleep(for: .milliseconds(100))
                } catch {
                    inputError = error
                }
                do {
                    let restoration = Task.detached {
                        let current = try await Self.pasteboard("pbpaste", udid: udid)
                        guard current == Data(text.utf8) else { return }
                        _ = try await Self.pasteboard("pbcopy", udid: udid, input: before)
                    }
                    try await restoration.value
                } catch {
                    let clearing = Task.detached {
                        let current = try? await Self.pasteboard("pbpaste", udid: udid)
                        if current == Data(text.utf8) {
                            _ = try? await Self.pasteboard("pbcopy", udid: udid, input: Data())
                        }
                    }
                    await clearing.value
                    throw CaptureError.unavailable("device pasteboard could not be restored after typing")
                }
                if let inputError { throw inputError }
            }
            self.pasteboardTransaction = transaction
            defer { self.pasteboardTransaction = nil }
            try await transaction.value
        default:
            throw CaptureError.invalidInput
        }
    }

    private func requireHealthyCapture(sessionId: String) throws {
        guard self.sessionId == sessionId, let frames = self.frames else { throw CaptureError.staleSession }
        if let failure = frames.failure { throw CaptureError.unavailable(failure) }
        guard self.captureProcess?.isRunning == true,
              let latest = frames.latest, latest.isFresh(at: Date()) else {
            throw CaptureError.unavailable("device frames stopped arriving")
        }
    }

    private func cancelHeldTouch(sessionId: String) {
        guard self.sessionId == sessionId, self.heldTouch else { return }
        self.heldTouch = false
        guard self.touchProcess?.isRunning == true else { return }
        _ = try? self.touchInputPipe?.fileHandleForWriting.write(contentsOf: Data([13, 0, 0, 0, 0, 0, 0, 0, 0]))
    }

    func stop(sessionId: String? = nil) async {
        if let stopTask = self.stopTask {
            await stopTask.value
            return
        }
        if let sessionId, self.sessionId != sessionId { return }
        // Retain one lifecycle owner across suspension so a new capture cannot
        // overlap HID release or device pasteboard restoration.
        let task = Task { @MainActor in await self.finishStop() }
        self.stopTask = task
        await task.value
    }

    private func finishStop() async {
        if let activeSession = self.sessionId { self.cancelHeldTouch(sessionId: activeSession) }
        let touchProcess = self.touchProcess
        let captureProcess = self.captureProcess
        let touchInputPipe = self.touchInputPipe
        let touchAckPipe = self.touchAckPipe
        let touchReady = self.touchReady
        let pasteboardTransaction = self.pasteboardTransaction
        self.reservationId = nil
        self.sessionId = nil
        self.expiry?.cancel()
        self.expiry = nil
        self.capturePipe?.fileHandleForReading.readabilityHandler = nil
        self.captureErrorPipe?.fileHandleForReading.readabilityHandler = nil
        self.touchErrorPipe?.fileHandleForReading.readabilityHandler = nil
        self.captureProcess = nil
        self.touchProcess = nil
        self.capturePipe = nil
        self.captureErrorPipe = nil
        self.touchErrorPipe = nil
        self.touchAckPipe = nil
        self.touchInputPipe = nil
        self.deviceUDID = nil
        self.frames = nil
        self.touchReady = nil
        self.heldTouch = false
        try? touchInputPipe?.fileHandleForWriting.close()
        // EOF is ordered after every queued HID frame. An earlier cancel ack
        // cannot stand in for the final release fence.
        let deadline = Date().addingTimeInterval(1.0)
        while touchProcess?.isRunning == true,
              touchReady?.inputEOF != true,
              Date() < deadline
        {
            try? await Task.sleep(for: .milliseconds(10))
        }
        touchAckPipe?.fileHandleForReading.readabilityHandler = nil
        if touchProcess?.isRunning == true { touchProcess?.terminate() }
        if captureProcess?.isRunning == true { captureProcess?.terminate() }
        // A canceled request can still be finishing pbcopy/conditional restore.
        // Revocation is complete only after that transaction settles.
        _ = try? await pasteboardTransaction?.value
        self.pasteboardTransaction = nil
        self.executionId = nil
        self.stopTask = nil
    }

    func stop(forExecutionId executionId: String) async {
        guard self.executionId == executionId else { return }
        await self.stop()
    }

    private static func helper(_ name: String, arguments: [String]) throws -> Process {
        guard let directory = Bundle.main.executableURL?.deletingLastPathComponent() else {
            throw CaptureError.unavailable("app bundle is unavailable")
        }
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.isExecutableFile(atPath: url.path) else {
            throw CaptureError.unavailable("\(name) is missing from this app build")
        }
        let process = Process()
        process.executableURL = url
        process.arguments = arguments
        return process
    }

    private static func pasteboard(_ action: String, udid: String, input: Data? = nil) async throws -> Data {
        do {
            let result = try await BoundedProcess.run(
                path: "/usr/bin/xcrun", arguments: ["simctl", action, udid],
                input: input, outputLimit: 64 * 1024, timeout: 2.5)
            guard result.terminationStatus == 0 else {
                throw CaptureError.unavailable("device pasteboard command failed")
            }
            return result.output
        } catch {
            throw CaptureError.unavailable("device pasteboard command failed")
        }
    }

    private static func bootedIOSDevice() async throws -> String {
        let data: Data
        do {
            let result = try await BoundedProcess.run(
                path: "/usr/bin/xcrun", arguments: ["simctl", "list", "devices", "booted", "--json"],
                outputLimit: 64 * 1024, timeout: 3)
            guard result.terminationStatus == 0 else {
                throw CaptureError.unavailable("xcrun simctl could not list booted devices")
            }
            data = result.output
        } catch {
            throw CaptureError.unavailable("xcrun simctl could not list booted devices")
        }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let devices = root["devices"] as? [String: [[String: Any]]] else {
            throw CaptureError.unavailable("xcrun simctl could not list booted devices")
        }
        let booted = devices.filter { $0.key.contains("SimRuntime.iOS-") }
            .flatMap { $0.value }.filter { $0["state"] as? String == "Booted" }
            .compactMap { $0["udid"] as? String }
        guard !booted.isEmpty else { throw CaptureError.noDevice }
        guard booted.count == 1 else { throw CaptureError.multipleDevices }
        return booted[0]
    }
}

final class SimulatorFrameBuffer: @unchecked Sendable {
    struct Latest {
        let sequence: UInt64
        let jpeg: Data
        let width: Int
        let height: Int
        let receivedAt: Date

        func isFresh(at date: Date) -> Bool { date.timeIntervalSince(self.receivedAt) < 3 }
    }
    private let lock = NSLock()
    private var buffer = Data()
    private var current: Latest?
    private var stoppedReason: String?
    var latest: Latest? { self.lock.withLock { self.current } }
    var failure: String? { self.lock.withLock { self.stoppedReason } }

    func append(_ data: Data) {
        self.lock.withLock {
            guard !data.isEmpty, self.stoppedReason == nil else { return }
            self.buffer.append(data)
            while self.buffer.count >= 4 {
                let length = self.buffer.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                guard length > 0, length <= 6_000_000 else {
                    self.stoppedReason = "invalid or oversized device frame"
                    return
                }
                guard self.buffer.count >= Int(length) + 4 else { return }
                let jpeg = Data(self.buffer[4..<(Int(length) + 4)])
                self.buffer.removeSubrange(0..<(Int(length) + 4))
                guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? Int,
                      let height = properties[kCGImagePropertyPixelHeight] as? Int else {
                    self.stoppedReason = "invalid JPEG device frame"
                    return
                }
                self.current = Latest(sequence: (self.current?.sequence ?? 0) + 1,
                                      jpeg: jpeg, width: width, height: height, receivedAt: Date())
            }
        }
    }

    func appendError(_ data: Data) {
        _ = data
    }

    func stop(_ reason: String) {
        self.lock.withLock { self.stoppedReason = reason }
    }
}

final class SimulatorTouchReadiness: @unchecked Sendable {
    private let lock = NSLock()
    private var output = ""
    private var isReady = false
    private var stoppedReason: String?
    private var acknowledgments: UInt64 = 0
    private var eofAcknowledged = false
    var ready: Bool { self.lock.withLock { self.isReady } }
    var failure: String? { self.lock.withLock { self.stoppedReason } }
    var cancelCount: UInt64 { self.lock.withLock { self.acknowledgments } }
    var inputEOF: Bool { self.lock.withLock { self.eofAcknowledged } }
    func append(_ data: Data) {
        self.lock.withLock {
            self.output = String((self.output + String(decoding: data, as: UTF8.self)).suffix(500))
            if self.output.contains("touch-helper ready") { self.isReady = true }
        }
    }
    func stop(_ reason: String) {
        self.lock.withLock { self.stoppedReason = reason }
    }
    func appendAck(_ data: Data) {
        self.lock.withLock {
            self.acknowledgments += UInt64(data.filter { $0 == 1 }.count)
            if data.contains(2) { self.eofAcknowledged = true }
        }
    }
}
