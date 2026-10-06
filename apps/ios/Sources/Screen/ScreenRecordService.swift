import AVFoundation
import OpenClawKit
import ReplayKit

final class ScreenRecordService: @unchecked Sendable {
    typealias CaptureHandler = @Sendable (CMSampleBuffer, RPSampleBufferType, Error?) -> Void
    typealias CaptureCompletion = @Sendable (Error?) -> Void
    typealias StartCaptureAction = @MainActor @Sendable (
        Bool,
        @escaping CaptureHandler,
        @escaping CaptureCompletion)
        -> Void
    typealias StopCaptureAction = @MainActor @Sendable (@escaping CaptureCompletion) -> Void

    private struct UncheckedSendableBox<T>: @unchecked Sendable {
        let value: T
    }

    private final class CaptureState: @unchecked Sendable {
        // The lock orders admission against finalization; writer state belongs to recordQueue.
        private let admissionLock = NSLock()
        var writer: AVAssetWriter?
        var videoInput: AVAssetWriterInput?
        var audioInput: AVAssetWriterInput?
        var sawVideo = false
        var lastVideoTime: CMTime?
        var handlerError: Error?
        var acceptingSamples = true

        func withAdmissionLock(_ body: (CaptureState) -> Void) {
            self.admissionLock.lock()
            defer { self.admissionLock.unlock() }
            body(self)
        }

        func recordError(_ error: Error) {
            if self.handlerError == nil { self.handlerError = error }
        }
    }

    /// Owns cancellation only until ReplayKit resolves startup. A cancelled
    /// pending start keeps its caller's capture lease until both start and the
    /// one matching stop resolve, so late capture cannot escape into a new owner.
    private final class CaptureStartOperation: @unchecked Sendable {
        private enum Phase {
            case idle
            case starting
            case cancelling
            case cancelled
            case finished
        }

        private struct State {
            var phase: Phase = .idle
            var continuation: CheckedContinuation<Void, Error>?
            var startResult: Result<Void, Error>?
            var stopRequested = false
            var stopCompleted = false
        }

        private let lock = NSLock()
        private var state = State()
        private let startAction: @MainActor @Sendable (@escaping CaptureCompletion) -> Void
        private let stopAction: StopCaptureAction

        init(
            startAction: @escaping @MainActor @Sendable (@escaping CaptureCompletion) -> Void,
            stopAction: @escaping StopCaptureAction)
        {
            self.startAction = startAction
            self.stopAction = stopAction
        }

        @MainActor
        func run() async throws {
            try Task.checkCancellation()
            try await withTaskCancellationHandler(operation: {
                try await withCheckedThrowingContinuation { continuation in
                    self.begin(continuation)
                }
            }, onCancel: {
                self.cancel()
            })
        }

        private func cancel() {
            self.withLock { state in
                switch state.phase {
                case .idle:
                    state.phase = .cancelled
                case .starting:
                    state.phase = .cancelling
                case .cancelling, .cancelled, .finished:
                    break
                }
            }
        }

        @MainActor
        private func begin(_ continuation: CheckedContinuation<Void, Error>) {
            let shouldStart = self.withLock { state -> Bool in
                switch state.phase {
                case .idle:
                    state.phase = .starting
                    state.continuation = continuation
                    return true
                case .cancelled:
                    state.phase = .finished
                    return false
                case .starting, .cancelling, .finished:
                    preconditionFailure("ReplayKit capture start operation can only run once")
                }
            }
            guard shouldStart else {
                continuation.resume(throwing: CancellationError())
                return
            }

            self.startAction { [weak self] error in
                self?.captureDidStart(error: error)
            }
        }

        private func captureDidStart(error: Error?) {
            let result: Result<Void, Error> = error.map(Result.failure) ?? .success(())
            var shouldStop = false
            let completion = self.withLock { state -> (CheckedContinuation<Void, Error>, Result<Void, Error>)? in
                switch state.phase {
                case .starting:
                    state.phase = .finished
                    guard let continuation = state.continuation else { return nil }
                    state.continuation = nil
                    return (continuation, result)
                case .cancelling:
                    state.startResult = result
                    if case .success = result, !state.stopRequested {
                        state.stopRequested = true
                        shouldStop = true
                    }
                    return Self.takeCancellationCompletionIfReady(state: &state)
                case .idle, .cancelled, .finished:
                    return nil
                }
            }
            if shouldStop {
                Task { @MainActor in self.requestStop() }
            }
            Self.resume(completion)
        }

        @MainActor
        private func requestStop() {
            self.stopAction { [weak self] _ in
                self?.captureStopDidComplete()
            }
        }

        private func captureStopDidComplete() {
            let completion = self.withLock { state -> (CheckedContinuation<Void, Error>, Result<Void, Error>)? in
                guard state.phase == .cancelling else { return nil }
                state.stopCompleted = true
                return Self.takeCancellationCompletionIfReady(state: &state)
            }
            Self.resume(completion)
        }

        private static func takeCancellationCompletionIfReady(
            state: inout State) -> (CheckedContinuation<Void, Error>, Result<Void, Error>)?
        {
            guard state.phase == .cancelling,
                  let startResult = state.startResult,
                  let continuation = state.continuation
            else { return nil }

            let cleanupComplete: Bool = switch startResult {
            case .success:
                state.stopRequested && state.stopCompleted
            case .failure:
                true
            }
            guard cleanupComplete else { return nil }

            state.phase = .finished
            state.continuation = nil
            return (continuation, .failure(CancellationError()))
        }

        private static func resume(
            _ completion: (CheckedContinuation<Void, Error>, Result<Void, Error>)?)
        {
            guard let (continuation, result) = completion else { return }
            continuation.resume(with: result)
        }

        private func withLock<T>(_ body: (inout State) -> T) -> T {
            self.lock.lock()
            defer { self.lock.unlock() }
            return body(&self.state)
        }
    }

    private let startReplayKitCaptureAction: StartCaptureAction
    private let stopReplayKitCaptureAction: StopCaptureAction
    private let recordQueue: DispatchQueue

    init(
        recordQueue: DispatchQueue = DispatchQueue(label: "ai.openclawfoundation.app.screenrecord"),
        startReplayKitCaptureAction: @escaping StartCaptureAction = { includeAudio, handler, completion in
            let recorder = RPScreenRecorder.shared()
            recorder.isMicrophoneEnabled = includeAudio
            recorder.startCapture(handler: handler, completionHandler: completion)
        },
        stopReplayKitCaptureAction: @escaping StopCaptureAction = { completion in
            RPScreenRecorder.shared().stopCapture { error in completion(error) }
        })
    {
        self.recordQueue = recordQueue
        self.startReplayKitCaptureAction = startReplayKitCaptureAction
        self.stopReplayKitCaptureAction = stopReplayKitCaptureAction
    }

    enum ScreenRecordError: LocalizedError {
        case invalidScreenIndex(Int)
        case captureFailed(String)
        case writeFailed(String)

        var errorDescription: String? {
            switch self {
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case let .captureFailed(msg), let .writeFailed(msg):
                msg
            }
        }
    }

    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> String
    {
        if let idx = screenIndex, idx != 0 {
            throw ScreenRecordError.invalidScreenIndex(idx)
        }
        let outURL = if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            URL(fileURLWithPath: outPath)
        } else {
            FileManager().temporaryDirectory
                .appendingPathComponent("openclaw-screen-record-\(UUID().uuidString).mp4")
        }
        let config = RecordConfig(
            durationMs: CaptureRateLimits.clampDurationMs(durationMs),
            fpsValue: Double(Int32(CaptureRateLimits.clampFps(fps, maxFps: 30).rounded())),
            includeAudio: includeAudio ?? true,
            outURL: outURL)
        try? FileManager().removeItem(at: outURL)

        let state = CaptureState()
        do {
            try await self.startCapture(state: state, config: config)
            do {
                try await Task.sleep(nanoseconds: UInt64(config.durationMs) * 1_000_000)
            } catch {
                try? await self.stopCapture()
                throw error
            }
            try await self.stopCapture()
            try await self.finishCapture(state: state)
            return config.outURL.path
        } catch {
            await self.discardCapture(state: state, outputURL: config.outURL)
            throw error
        }
    }

    private struct RecordConfig {
        let durationMs: Int
        let fpsValue: Double
        let includeAudio: Bool
        let outURL: URL
    }

    @MainActor
    private func startCapture(
        state: CaptureState,
        config: RecordConfig) async throws
    {
        let handler = self.makeCaptureHandler(
            state: state,
            config: config)
        let operation = CaptureStartOperation(
            startAction: { completion in
                self.startReplayKitCaptureAction(
                    config.includeAudio,
                    handler,
                    completion)
            },
            stopAction: self.stopReplayKitCaptureAction)
        try await operation.run()
    }

    private func makeCaptureHandler(
        state: CaptureState,
        config: RecordConfig) -> @Sendable (CMSampleBuffer, RPSampleBufferType, Error?) -> Void
    {
        { sample, type, error in
            let sampleBox = UncheckedSendableBox(value: sample)
            // ReplayKit can call the capture handler on a background queue.
            // Enqueue under the state lock so closing capture forms a barrier:
            // every accepted sample precedes finalization/discard, and none follow.
            state.withAdmissionLock { captureState in
                guard captureState.acceptingSamples else { return }
                self.recordQueue.async {
                    let sample = sampleBox.value
                    if let error {
                        state.recordError(error)
                        return
                    }
                    guard CMSampleBufferDataIsReady(sample) else { return }

                    switch type {
                    case .video:
                        self.handleVideoSample(sample, state: state, config: config)
                    case .audioApp, .audioMic:
                        self.handleAudioSample(sample, state: state, includeAudio: config.includeAudio)
                    @unknown default:
                        break
                    }
                }
            }
        }
    }

    private func handleVideoSample(
        _ sample: CMSampleBuffer,
        state: CaptureState,
        config: RecordConfig)
    {
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        if let lastVideoTime = state.lastVideoTime,
           CMTimeSubtract(pts, lastVideoTime).seconds < (1.0 / config.fpsValue)
        {
            return
        }

        if state.writer == nil {
            self.prepareWriter(sample: sample, state: state, config: config, pts: pts)
        }

        guard let vInput = state.videoInput, vInput.isReadyForMoreMediaData else { return }
        if vInput.append(sample) {
            state.sawVideo = true
            state.lastVideoTime = pts
        } else if let error = state.writer?.error {
            state.recordError(ScreenRecordError.writeFailed(error.localizedDescription))
        }
    }

    private func prepareWriter(
        sample: CMSampleBuffer,
        state: CaptureState,
        config: RecordConfig,
        pts: CMTime)
    {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sample) else {
            state.recordError(ScreenRecordError.captureFailed("Missing image buffer"))
            return
        }
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        do {
            let writer = try AVAssetWriter(outputURL: config.outURL, fileType: .mp4)
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
            ]
            let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            vInput.expectsMediaDataInRealTime = true
            guard writer.canAdd(vInput) else {
                throw ScreenRecordError.writeFailed("Cannot add video input")
            }
            writer.add(vInput)

            if config.includeAudio {
                let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: nil)
                aInput.expectsMediaDataInRealTime = true
                if writer.canAdd(aInput) {
                    writer.add(aInput)
                    state.audioInput = aInput
                }
            }

            guard writer.startWriting() else {
                throw ScreenRecordError.writeFailed(
                    writer.error?.localizedDescription ?? "Failed to start writer")
            }
            writer.startSession(atSourceTime: pts)
            state.writer = writer
            state.videoInput = vInput
        } catch {
            state.recordError(error)
        }
    }

    private func handleAudioSample(
        _ sample: CMSampleBuffer,
        state: CaptureState,
        includeAudio: Bool)
    {
        guard includeAudio, let aInput = state.audioInput, state.writer != nil else { return }
        if aInput.isReadyForMoreMediaData {
            _ = aInput.append(sample)
        }
    }

    @MainActor
    private func stopCapture() async throws {
        let stopError = await withCheckedContinuation { cont in
            self.stopReplayKitCaptureAction { error in
                cont.resume(returning: error)
            }
        }
        if let stopError {
            throw stopError
        }
    }

    private func finishCapture(state: CaptureState) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            // ReplayKit has stopped, so finalization can queue behind every pending sample.
            // AVAssetWriter requires all append calls to return before finishWriting starts.
            state.withAdmissionLock { captureState in
                captureState.acceptingSamples = false
                self.recordQueue.async {
                    do {
                        if let handlerError = state.handlerError {
                            throw handlerError
                        }
                        guard let writer = state.writer, let videoInput = state.videoInput, state.sawVideo else {
                            throw ScreenRecordError.captureFailed("No frames captured")
                        }

                        videoInput.markAsFinished()
                        state.audioInput?.markAsFinished()
                        let writerBox = UncheckedSendableBox(value: writer)
                        writer.finishWriting {
                            let writer = writerBox.value
                            if let error = writer.error {
                                cont.resume(throwing: ScreenRecordError.writeFailed(error.localizedDescription))
                            } else if writer.status != .completed {
                                cont.resume(throwing: ScreenRecordError.writeFailed("Failed to finalize video"))
                            } else {
                                cont.resume()
                            }
                        }
                    } catch {
                        cont.resume(throwing: error)
                    }
                }
            }
        }
    }

    private func discardCapture(state: CaptureState, outputURL: URL) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            state.withAdmissionLock { captureState in
                captureState.acceptingSamples = false
                self.recordQueue.async {
                    let writer = state.writer
                    state.writer = nil
                    state.videoInput = nil
                    state.audioInput = nil
                    writer?.cancelWriting()
                    try? FileManager.default.removeItem(at: outputURL)
                    cont.resume()
                }
            }
        }
    }
}
