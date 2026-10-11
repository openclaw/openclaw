import AVFoundation
import Foundation
import OpenClawKit
import OSLog
@preconcurrency import ScreenCaptureKit

@MainActor
final class ScreenRecordService {
    enum ScreenRecordError: LocalizedError {
        case noDisplays
        case invalidScreenIndex(Int)
        case noFramesCaptured
        case writeFailed(String)

        var errorDescription: String? {
            switch self {
            case .noDisplays:
                "No displays available for screen recording"
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case .noFramesCaptured:
                "No frames captured"
            case let .writeFailed(msg):
                msg
            }
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "screenRecord")

    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?) async throws -> (path: String, hasAudio: Bool)
    {
        guard AppLaunchRuntimePlan.current.allowsActivation ||
            PermissionManager.screenRecordingPermissions.checkScreenRecordingPermission()
        else {
            throw ScreenRecordError.writeFailed(
                "Screen Recording permission required; relaunch without --no-activate and retry")
        }
        let durationMs = CaptureRateLimits.clampDurationMs(durationMs)
        let fps = CaptureRateLimits.clampFps(fps, maxFps: 60)
        let includeAudio = includeAudio ?? false

        let outURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-screen-record-\(UUID().uuidString).mp4")
        try? FileManager().removeItem(at: outURL)

        let content = try await SCShareableContent.current
        let displays = content.displays.sorted { $0.displayID < $1.displayID }
        guard !displays.isEmpty else { throw ScreenRecordError.noDisplays }

        let idx = screenIndex ?? 0
        guard idx >= 0, idx < displays.count else { throw ScreenRecordError.invalidScreenIndex(idx) }
        let display = displays[idx]

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.queueDepth = 8
        config.showsCursor = true
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, Int32(fps.rounded()))))
        if includeAudio {
            config.capturesAudio = true
        }

        let recorder = try StreamRecorder(
            outputURL: outURL,
            width: display.width,
            height: display.height,
            includeAudio: includeAudio,
            logger: self.logger)

        let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
        try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.queue)
        if includeAudio {
            try stream.addStreamOutput(recorder, type: .audio, sampleHandlerQueue: recorder.queue)
        }

        self.logger.info(
            "screen record start idx=\(idx) durationMs=\(durationMs) fps=\(fps) out=\(outURL.path, privacy: .public)")

        var started = false
        do {
            try await stream.startCapture()
            started = true
            try await Task.sleep(nanoseconds: UInt64(durationMs) * 1_000_000)
            try await stream.stopCapture()
        } catch {
            if started { try? await stream.stopCapture() }
            throw error
        }

        try await recorder.finish()
        return (path: outURL.path, hasAudio: recorder.hasAudio)
    }
}

private final class StreamRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "ai.openclaw.screenRecord.writer")

    private let logger: Logger
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?

    var hasAudio: Bool {
        self.audioInput != nil
    }

    private var started = false
    private var didFinish = false
    private var pendingErrorMessage: String?

    init(outputURL: URL, width: Int, height: Int, includeAudio: Bool, logger: Logger) throws {
        self.logger = logger
        self.writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)

        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ]
        self.input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        self.input.expectsMediaDataInRealTime = true

        guard self.writer.canAdd(self.input) else {
            throw ScreenRecordService.ScreenRecordError.writeFailed("Cannot add video input")
        }
        self.writer.add(self.input)

        var audioInput: AVAssetWriterInput?
        if includeAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 1,
                AVSampleRateKey: 44100,
                AVEncoderBitRateKey: 96000,
            ]
            let candidate = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            candidate.expectsMediaDataInRealTime = true
            if self.writer.canAdd(candidate) {
                self.writer.add(candidate)
                audioInput = candidate
            }
        }
        self.audioInput = audioInput
        super.init()
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        self.queue.async {
            let msg = String(describing: error)
            self.pendingErrorMessage = msg
            self.logger.error("screen record stream stopped with error: \(msg, privacy: .public)")
            _ = stream
        }
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType)
    {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        // Callback runs on `sampleHandlerQueue` (`self.queue`).
        let input: AVAssetWriterInput
        switch type {
        case .screen:
            input = self.input
        case .audio:
            guard let audioInput else { return }
            input = audioInput
        case .microphone:
            return
        @unknown default:
            return
        }
        _ = stream
        if let msg = self.pendingErrorMessage {
            let source = type == .audio ? "audio " : ""
            self.logger
                .error("screen record \(source, privacy: .public)aborting due to prior error: \(msg, privacy: .public)")
            return
        }
        if self.didFinish { return }

        if !self.started {
            guard type == .screen else { return }
            guard self.writer.startWriting() else {
                self.pendingErrorMessage = self.writer.error?.localizedDescription ?? "Failed to start writer"
                return
            }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            self.writer.startSession(atSourceTime: pts)
            self.started = true
        }

        if input.isReadyForMoreMediaData {
            _ = input.append(sampleBuffer)
        }
    }

    func finish() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.queue.async {
                if let msg = self.pendingErrorMessage {
                    cont.resume(throwing: ScreenRecordService.ScreenRecordError.writeFailed(msg))
                    return
                }
                guard self.started else {
                    cont.resume(throwing: ScreenRecordService.ScreenRecordError.noFramesCaptured)
                    return
                }
                if self.didFinish {
                    cont.resume()
                    return
                }
                self.didFinish = true

                self.input.markAsFinished()
                self.audioInput?.markAsFinished()
                self.writer.finishWriting {
                    let failure = self.writer.error?.localizedDescription ??
                        (self.writer.status == .completed ? nil : "Failed to finalize video")
                    if let failure {
                        cont.resume(throwing: ScreenRecordService.ScreenRecordError.writeFailed(failure))
                    } else {
                        cont.resume()
                    }
                }
            }
        }
    }
}
