import AVFoundation
import UIKit

@MainActor
final class ScreenRecordService {
    enum ScreenRecordError: LocalizedError {
        case noWindow
        case invalidScreenIndex(Int)
        case captureFailed(String)
        case writeFailed(String)

        var errorDescription: String? {
            switch self {
            case .noWindow:
                return "Screen capture unavailable"
            case let .invalidScreenIndex(idx):
                return "Invalid screen index \(idx)"
            case let .captureFailed(msg):
                return msg
            case let .writeFailed(msg):
                return msg
            }
        }
    }

    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        outPath: String?) async throws -> String
    {
        let durationMs = Self.clampDurationMs(durationMs)
        let fps = Self.clampFps(fps)
        let fpsInt = Int32(fps.rounded())
        let fpsValue = Double(fpsInt)

        let outURL: URL = {
            if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return URL(fileURLWithPath: outPath)
            }
            return FileManager.default.temporaryDirectory
                .appendingPathComponent("clawdis-screen-record-\(UUID().uuidString).mp4")
        }()
        try? FileManager.default.removeItem(at: outURL)

        if let idx = screenIndex, idx != 0 {
            throw ScreenRecordError.invalidScreenIndex(idx)
        }

        guard let window = Self.resolveKeyWindow() else {
            throw ScreenRecordError.noWindow
        }

        let size = window.bounds.size
        let scale = window.screen.scale
        let widthPx = max(1, Int(size.width * scale))
        let heightPx = max(1, Int(size.height * scale))

        let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: widthPx,
            AVVideoHeightKey: heightPx,
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false

        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: widthPx,
            kCVPixelBufferHeightKey as String: heightPx,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: attrs)

        guard writer.canAdd(input) else {
            throw ScreenRecordError.writeFailed("Cannot add video input")
        }
        writer.add(input)

        guard writer.startWriting() else {
            throw ScreenRecordError.writeFailed(writer.error?.localizedDescription ?? "Failed to start writer")
        }
        writer.startSession(atSourceTime: .zero)

        let frameCount = max(1, Int((Double(durationMs) / 1000.0 * fpsValue).rounded(.up)))
        let frameDuration = CMTime(value: 1, timescale: fpsInt)
        let frameSleepNs = UInt64(1_000_000_000.0 / fpsValue)

        for frame in 0..<frameCount {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 10_000_000)
            }

            var frameError: Error?
            autoreleasepool {
                do {
                    guard let image = Self.captureImage(window: window, size: size) else {
                        throw ScreenRecordError.captureFailed("Failed to capture frame")
                    }
                    guard let buffer = Self.pixelBuffer(from: image, width: widthPx, height: heightPx) else {
                        throw ScreenRecordError.captureFailed("Failed to render frame")
                    }
                    let time = CMTimeMultiply(frameDuration, multiplier: Int32(frame))
                    if !adaptor.append(buffer, withPresentationTime: time) {
                        throw ScreenRecordError.writeFailed("Failed to append frame")
                    }
                } catch {
                    frameError = error
                }
            }
            if let frameError { throw frameError }

            if frame < frameCount - 1 {
                try await Task.sleep(nanoseconds: frameSleepNs)
            }
        }

        input.markAsFinished()
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
        let v = ms ?? 10_000
        return min(60_000, max(250, v))
    }

    private nonisolated static func clampFps(_ fps: Double?) -> Double {
        let v = fps ?? 10
        if !v.isFinite { return 10 }
        return min(30, max(1, v))
    }

    private nonisolated static func resolveKeyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes
        for scene in scenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            if let window = windowScene.windows.first(where: { $0.isKeyWindow }) {
                return window
            }
            if let window = windowScene.windows.first {
                return window
            }
        }
        return nil
    }

    private nonisolated static func captureImage(window: UIWindow, size: CGSize) -> CGImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = window.screen.scale
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let image = renderer.image { _ in
            window.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: false)
        }
        return image.cgImage
    }

    private nonisolated static func pixelBuffer(from image: CGImage, width: Int, height: Int) -> CVPixelBuffer? {
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            ] as CFDictionary,
            &buffer)
        guard status == kCVReturnSuccess, let buffer else { return nil }

        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer),
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
        ) else {
            return nil
        }

        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return buffer
    }
}
