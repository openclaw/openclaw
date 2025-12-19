import AVFoundation
import ReplayKit

@MainActor
final class ScreenRecordService {
    enum ScreenRecordError: LocalizedError {
        case invalidScreenIndex(Int)
        case captureFailed(String)
        case writeFailed(String)

        var errorDescription: String? {
            switch self {
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case let .captureFailed(msg):
                msg
            case let .writeFailed(msg):
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
        let durationMs = Self.clampDurationMs(durationMs)
        let fps = Self.clampFps(fps)
        let fpsInt = Int32(fps.rounded())
        let fpsValue = Double(fpsInt)
        let includeAudio = includeAudio ?? true

        if let idx = screenIndex, idx != 0 {
            throw ScreenRecordError.invalidScreenIndex(idx)
        }

        let outURL: URL = {
            if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return URL(fileURLWithPath: outPath)
            }
            return FileManager.default.temporaryDirectory
                .appendingPathComponent("clawdis-screen-record-\(UUID().uuidString).mp4")
        }()
        try? FileManager.default.removeItem(at: outURL)

        let recorder = RPScreenRecorder.shared()
        recorder.isMicrophoneEnabled = includeAudio

        var writer: AVAssetWriter?
        var videoInput: AVAssetWriterInput?
        var audioInput: AVAssetWriterInput?
        var started = false
        var sawVideo = false
        var lastVideoTime: CMTime?
        var handlerError: Error?
        let lock = NSLock()

        func setHandlerError(_ error: Error) {
            lock.lock()
            defer { lock.unlock() }
            if handlerError == nil { handlerError = error }
        }

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            recorder.startCapture(handler: { sample, type, error in
                if let error {
                    setHandlerError(error)
                    return
                }
                guard CMSampleBufferDataIsReady(sample) else { return }

                switch type {
                case .video:
                    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                    if let lastVideoTime {
                        let delta = CMTimeSubtract(pts, lastVideoTime)
                        if delta.seconds < (1.0 / fpsValue) { return }
                    }

                    if writer == nil {
                        guard let imageBuffer = CMSampleBufferGetImageBuffer(sample) else {
                            setHandlerError(ScreenRecordError.captureFailed("Missing image buffer"))
                            return
                        }
                        let width = CVPixelBufferGetWidth(imageBuffer)
                        let height = CVPixelBufferGetHeight(imageBuffer)
                        do {
                            let w = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
                            let settings: [String: Any] = [
                                AVVideoCodecKey: AVVideoCodecType.h264,
                                AVVideoWidthKey: width,
                                AVVideoHeightKey: height,
                            ]
                            let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
                            vInput.expectsMediaDataInRealTime = true
                            guard w.canAdd(vInput) else {
                                throw ScreenRecordError.writeFailed("Cannot add video input")
                            }
                            w.add(vInput)

                            if includeAudio {
                                let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: nil)
                                aInput.expectsMediaDataInRealTime = true
                                if w.canAdd(aInput) {
                                    w.add(aInput)
                                    audioInput = aInput
                                }
                            }

                            guard w.startWriting() else {
                                throw ScreenRecordError
                                    .writeFailed(w.error?.localizedDescription ?? "Failed to start writer")
                            }
                            w.startSession(atSourceTime: pts)
                            writer = w
                            videoInput = vInput
                            started = true
                        } catch {
                            setHandlerError(error)
                            return
                        }
                    }

                    guard let vInput = videoInput, started else { return }
                    if vInput.isReadyForMoreMediaData {
                        if vInput.append(sample) {
                            sawVideo = true
                            lastVideoTime = pts
                        } else {
                            if let err = writer?.error {
                                setHandlerError(ScreenRecordError.writeFailed(err.localizedDescription))
                            }
                        }
                    }

                case .audioApp, .audioMic:
                    guard includeAudio, let aInput = audioInput, started else { return }
                    if aInput.isReadyForMoreMediaData {
                        _ = aInput.append(sample)
                    }

                @unknown default:
                    break
                }
            }, completionHandler: { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            })
        }

        try await Task.sleep(nanoseconds: UInt64(durationMs) * 1_000_000)

        let stopError = await withCheckedContinuation { cont in
            recorder.stopCapture { error in cont.resume(returning: error) }
        }
        if let stopError { throw stopError }

        if let handlerError { throw handlerError }
        guard let writer, let videoInput, sawVideo else {
            throw ScreenRecordError.captureFailed("No frames captured")
        }

        videoInput.markAsFinished()
        audioInput?.markAsFinished()

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            writer.finishWriting {
                if let err = writer.error {
                    cont.resume(throwing: ScreenRecordError.writeFailed(err.localizedDescription))
                } else if writer.status != .completed {
                    cont.resume(throwing: ScreenRecordError.writeFailed("Failed to finalize video"))
                } else {
                    cont.resume()
                }
            }
        }

        return outURL.path
    }

    private nonisolated static func clampDurationMs(_ ms: Int?) -> Int {
        let v = ms ?? 10000
        return min(60000, max(250, v))
    }

    private nonisolated static func clampFps(_ fps: Double?) -> Double {
        let v = fps ?? 10
        if !v.isFinite { return 10 }
        return min(30, max(1, v))
    }
}
