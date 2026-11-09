import AppKit
import CoreImage
import Foundation
import OpenClawKit
@preconcurrency import ScreenCaptureKit

/// Keeps only the newest Simulator frame. A slow viewer never queues old pixels.
@MainActor
final class SimulatorCaptureService {
    enum CaptureError: LocalizedError {
        case noWindow
        case staleSession
        case noDisplay
        case changedWindow
        case captureStopped(String)

        var errorDescription: String? {
            switch self {
            case .noWindow: "Open Simulator and boot an iOS device, then retry."
            case .staleSession: "Simulator preview ended; reopen it to start a new capture."
            case .noDisplay: "The Simulator window is not on an available display."
            case .changedWindow: "Simulator moved or resized; reopen the preview to realign input."
            case let .captureStopped(reason): "Simulator capture stopped: \(reason). Reopen the preview."
            }
        }
    }

    struct Frame: Encodable {
        let sessionId: String
        let sequence: UInt64
        let jpegBase64: String?
        let width: Int
        let height: Int
        let windowX: Double
        let windowY: Double
        let windowWidth: Double
        let windowHeight: Double
        let displayX: Double
        let displayY: Double
        let displayWidth: Double
        let screenIndex: Int
        let refWidth: Int
        let displayFrameId: String
    }

    private var stream: SCStream?
    private var output: SimulatorFrameOutput?
    private var sessionId: String?
    private var metadata: Frame?
    private var windowID: CGWindowID?
    private var windowFrame: CGRect?
    private var simulatorPID: pid_t?
    private var lastGeometryCheck = Date.distantPast
    private var lastRead = Date.distantPast
    private var expiry: Task<Void, Never>?

    func start() async throws -> Frame {
        try await ScreenCaptureSupport.requirePermission()
        await self.stop()
        let content = try await SCShareableContent.current
        let windows = content.windows.filter {
            $0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator" &&
                $0.isOnScreen && $0.frame.width > 100 && $0.frame.height > 100
        }
        guard let window = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        else { throw CaptureError.noWindow }
        let displays = content.displays.sorted { $0.displayID < $1.displayID }
        guard let screenIndex = displays.firstIndex(where: { CGDisplayBounds($0.displayID).intersects(window.frame) })
        else { throw CaptureError.noDisplay }
        let display = displays[screenIndex]
        let refWidth = display.width
        let geometry = try ScreenCaptureDisplayGeometry(display: display, noDisplays: CaptureError.noDisplay)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = min(1, 1400 / max(window.frame.width, window.frame.height))
        config.width = max(1, Int((window.frame.width * scale).rounded()))
        config.height = max(1, Int((window.frame.height * scale).rounded()))
        config.minimumFrameInterval = CMTime(value: 1, timescale: 12)
        config.queueDepth = 2
        config.showsCursor = false
        let output = SimulatorFrameOutput()
        let stream = SCStream(filter: filter, configuration: config, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
        try await stream.startCapture()
        let sessionId = UUID().uuidString
        self.sessionId = sessionId
        self.stream = stream
        self.output = output
        self.windowID = window.windowID
        self.windowFrame = window.frame
        self.simulatorPID = window.owningApplication?.processID
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
        let metadata = Frame(
            sessionId: sessionId, sequence: 0, jpegBase64: nil,
            width: config.width, height: config.height,
            windowX: Double(window.frame.minX), windowY: Double(window.frame.minY),
            windowWidth: Double(window.frame.width), windowHeight: Double(window.frame.height),
            displayX: geometry.geometry.originX, displayY: geometry.geometry.originY,
            displayWidth: geometry.geometry.widthPoints,
            screenIndex: screenIndex, refWidth: refWidth,
            displayFrameId: geometry.frameId(referenceWidth: refWidth))
        self.metadata = metadata
        return metadata
    }

    func read(sessionId: String, after sequence: UInt64) async throws -> Frame {
        guard self.sessionId == sessionId, let output, let metadata else { throw CaptureError.staleSession }
        if let failure = output.failure() { throw CaptureError.captureStopped(failure) }
        if Date().timeIntervalSince(self.lastGeometryCheck) >= 1 {
            try await self.validateWindow(sessionId: sessionId)
            self.lastGeometryCheck = Date()
        }
        self.lastRead = Date()
        let latest = output.latest()
        return Frame(
            sessionId: sessionId, sequence: latest?.sequence ?? 0,
            jpegBase64: (latest?.sequence ?? 0) > sequence ? latest?.data.base64EncodedString() : nil,
            width: latest?.width ?? metadata.width, height: latest?.height ?? metadata.height,
            windowX: metadata.windowX, windowY: metadata.windowY,
            windowWidth: metadata.windowWidth, windowHeight: metadata.windowHeight,
            displayX: metadata.displayX, displayY: metadata.displayY,
            displayWidth: metadata.displayWidth,
            screenIndex: metadata.screenIndex, refWidth: metadata.refWidth,
            displayFrameId: metadata.displayFrameId)
    }

    func input(
        sessionId: String,
        action: OpenClawComputerAction,
        x: Double?, y: Double?, text: String?, keys: String?) async throws -> OpenClawComputerActParams
    {
        try await self.validateWindow(sessionId: sessionId)
        guard let metadata else { throw CaptureError.staleSession }
        guard [.leftClick, .leftMouseDown, .mouseMove, .leftMouseUp, .type, .key].contains(action) else {
            throw CaptureError.staleSession
        }
        let point: (Double, Double)?
        if let x, let y, x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) {
            let scale = Double(metadata.refWidth) / metadata.displayWidth
            point = (
                (metadata.windowX - metadata.displayX + x * metadata.windowWidth) * scale,
                (metadata.windowY - metadata.displayY + y * metadata.windowHeight) * scale)
        } else if action == .type || action == .key {
            point = nil
        } else {
            throw CaptureError.staleSession
        }
        return OpenClawComputerActParams(
            action: action, displayFrameId: point == nil ? nil : metadata.displayFrameId,
            x: point?.0, y: point?.1, text: text, keys: keys,
            screenIndex: metadata.screenIndex, refWidth: metadata.refWidth,
            deliveryMode: .foreground)
    }

    func activate(sessionId: String) throws {
        guard self.sessionId == sessionId, let simulatorPID else { throw CaptureError.staleSession }
        NSRunningApplication(processIdentifier: simulatorPID)?.activate()
    }

    private func validateWindow(sessionId: String) async throws {
        guard self.sessionId == sessionId, let windowID, let windowFrame else {
            throw CaptureError.staleSession
        }
        let content = try await SCShareableContent.current
        guard let window = content.windows.first(where: {
            $0.windowID == windowID && $0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator"
        }), window.isOnScreen, window.frame == windowFrame else {
            throw CaptureError.changedWindow
        }
        guard self.sessionId == sessionId else { throw CaptureError.staleSession }
    }

    func stop(sessionId: String? = nil) async {
        if let sessionId, self.sessionId != sessionId { return }
        self.expiry?.cancel()
        self.expiry = nil
        let stream = self.stream
        self.stream = nil
        self.output = nil
        self.sessionId = nil
        self.metadata = nil
        self.windowID = nil
        self.windowFrame = nil
        self.simulatorPID = nil
        if let stream { try? await stream.stopCapture() }
    }
}

private final class SimulatorFrameOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "ai.openclaw.simulator.capture")
    private let lock = NSLock()
    private let context = CIContext()
    private var frame: (sequence: UInt64, data: Data, width: Int, height: Int)?
    private var stoppedReason: String?

    func latest() -> (sequence: UInt64, data: Data, width: Int, height: Int)? {
        self.lock.withLock { self.frame }
    }

    func failure() -> String? { self.lock.withLock { self.stoppedReason } }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        self.lock.withLock { self.stoppedReason = error.localizedDescription }
        _ = stream
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferDataIsReady(sampleBuffer),
              let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        let image = CIImage(cvPixelBuffer: imageBuffer)
        guard let cgImage = self.context.createCGImage(image, from: image.extent),
              let jpeg = NSBitmapImageRep(cgImage: cgImage).representation(
                using: .jpeg, properties: [.compressionFactor: 0.66])
        else { return }
        self.lock.withLock {
            self.frame = ((self.frame?.sequence ?? 0) + 1, jpeg, cgImage.width, cgImage.height)
        }
        _ = stream
    }
}
