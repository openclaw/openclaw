import AVFoundation
import ClawdisIPC
import CoreGraphics
import Foundation
import ImageIO
import OSLog
import UniformTypeIdentifiers

actor CameraCaptureService {
    enum CameraError: LocalizedError, Sendable {
        case cameraUnavailable
        case microphoneUnavailable
        case permissionDenied(kind: String)
        case captureFailed(String)
        case exportFailed(String)

        var errorDescription: String? {
            switch self {
            case .cameraUnavailable:
                "Camera unavailable"
            case .microphoneUnavailable:
                "Microphone unavailable"
            case let .permissionDenied(kind):
                "\(kind) permission denied"
            case let .captureFailed(msg):
                msg
            case let .exportFailed(msg):
                msg
            }
        }
    }

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "camera")

    func snap(facing: CameraFacing?, maxWidth: Int?, quality: Double?) async throws -> (data: Data, size: CGSize) {
        let facing = facing ?? .front
        let maxWidth = maxWidth.flatMap { $0 > 0 ? $0 : nil }
        let quality = Self.clampQuality(quality)

        try await self.ensureAccess(for: .video)

        let session = AVCaptureSession()
        session.sessionPreset = .photo

        guard let device = Self.pickCamera(facing: facing) else {
            throw CameraError.cameraUnavailable
        }

        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw CameraError.captureFailed("Failed to add camera input")
        }
        session.addInput(input)

        let output = AVCapturePhotoOutput()
        guard session.canAddOutput(output) else {
            throw CameraError.captureFailed("Failed to add photo output")
        }
        session.addOutput(output)
        output.maxPhotoQualityPrioritization = .quality

        session.startRunning()
        defer { session.stopRunning() }

        let settings: AVCapturePhotoSettings = {
            if output.availablePhotoCodecTypes.contains(.jpeg) {
                return AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            }
            return AVCapturePhotoSettings()
        }()
        settings.photoQualityPrioritization = .quality

        let rawData: Data = try await withCheckedThrowingContinuation(isolation: nil) { cont in
            output.capturePhoto(with: settings, delegate: PhotoCaptureDelegate(cont))
        }

        return try Self.reencodeJPEG(imageData: rawData, maxWidth: maxWidth, quality: quality)
    }

    func clip(
        facing: CameraFacing?,
        durationMs: Int?,
        includeAudio: Bool,
        outPath: String?) async throws -> (path: String, durationMs: Int, hasAudio: Bool)
    {
        let facing = facing ?? .front
        let durationMs = Self.clampDurationMs(durationMs)

        try await self.ensureAccess(for: .video)
        if includeAudio {
            try await self.ensureAccess(for: .audio)
        }

        let session = AVCaptureSession()
        session.sessionPreset = .high

        guard let camera = Self.pickCamera(facing: facing) else {
            throw CameraError.cameraUnavailable
        }
        let cameraInput = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(cameraInput) else {
            throw CameraError.captureFailed("Failed to add camera input")
        }
        session.addInput(cameraInput)

        if includeAudio {
            guard let mic = AVCaptureDevice.default(for: .audio) else {
                throw CameraError.microphoneUnavailable
            }
            let micInput = try AVCaptureDeviceInput(device: mic)
            guard session.canAddInput(micInput) else {
                throw CameraError.captureFailed("Failed to add microphone input")
            }
            session.addInput(micInput)
        }

        let output = AVCaptureMovieFileOutput()
        guard session.canAddOutput(output) else {
            throw CameraError.captureFailed("Failed to add movie output")
        }
        session.addOutput(output)
        output.maxRecordedDuration = CMTime(value: Int64(durationMs), timescale: 1000)

        session.startRunning()
        defer { session.stopRunning() }

        let tmpMovURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-camera-\(UUID().uuidString).mov")
        defer { try? FileManager.default.removeItem(at: tmpMovURL) }

        let outputURL: URL = {
            if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return URL(fileURLWithPath: outPath)
            }
            return FileManager.default.temporaryDirectory
                .appendingPathComponent("clawdis-camera-\(UUID().uuidString).mp4")
        }()

        // Ensure we don't fail exporting due to an existing file.
        try? FileManager.default.removeItem(at: outputURL)

        let logger = self.logger
        let recordedURL: URL = try await withCheckedThrowingContinuation(isolation: nil) { cont in
            output.startRecording(to: tmpMovURL, recordingDelegate: MovieFileDelegate(cont, logger: logger))
        }

        try await Self.exportToMP4(inputURL: recordedURL, outputURL: outputURL)
        return (path: outputURL.path, durationMs: durationMs, hasAudio: includeAudio)
    }

    private func ensureAccess(for mediaType: AVMediaType) async throws {
        let status = AVCaptureDevice.authorizationStatus(for: mediaType)
        switch status {
        case .authorized:
            return
        case .notDetermined:
            let ok = await withCheckedContinuation(isolation: nil) { cont in
                AVCaptureDevice.requestAccess(for: mediaType) { granted in
                    cont.resume(returning: granted)
                }
            }
            if !ok {
                throw CameraError.permissionDenied(kind: mediaType == .video ? "Camera" : "Microphone")
            }
        case .denied, .restricted:
            throw CameraError.permissionDenied(kind: mediaType == .video ? "Camera" : "Microphone")
        @unknown default:
            throw CameraError.permissionDenied(kind: mediaType == .video ? "Camera" : "Microphone")
        }
    }

    private nonisolated static func pickCamera(facing: CameraFacing) -> AVCaptureDevice? {
        let position: AVCaptureDevice.Position = (facing == .front) ? .front : .back

        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) {
            return device
        }

        // Many macOS cameras report `unspecified` position; fall back to any default.
        return AVCaptureDevice.default(for: .video)
    }

    private nonisolated static func clampQuality(_ quality: Double?) -> Double {
        let q = quality ?? 0.9
        return min(1.0, max(0.05, q))
    }

    private nonisolated static func clampDurationMs(_ ms: Int?) -> Int {
        let v = ms ?? 3000
        return min(15000, max(250, v))
    }

    private nonisolated static func reencodeJPEG(
        imageData: Data,
        maxWidth: Int?,
        quality: Double) throws -> (data: Data, size: CGSize)
    {
        guard let src = CGImageSourceCreateWithData(imageData as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
        else {
            throw CameraError.captureFailed("Failed to decode captured image")
        }

        let finalImage: CGImage
        if let maxWidth, img.width > maxWidth {
            guard let scaled = self.downscale(image: img, maxWidth: maxWidth) else {
                throw CameraError.captureFailed("Failed to downscale image")
            }
            finalImage = scaled
        } else {
            finalImage = img
        }

        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw CameraError.captureFailed("Failed to create JPEG destination")
        }

        let props = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImage(dest, finalImage, props)
        guard CGImageDestinationFinalize(dest) else {
            throw CameraError.captureFailed("Failed to encode JPEG")
        }

        return (out as Data, CGSize(width: finalImage.width, height: finalImage.height))
    }

    private nonisolated static func downscale(image: CGImage, maxWidth: Int) -> CGImage? {
        guard image.width > 0, image.height > 0 else { return image }
        guard image.width > maxWidth else { return image }

        let scale = Double(maxWidth) / Double(image.width)
        let targetW = maxWidth
        let targetH = max(1, Int((Double(image.height) * scale).rounded()))

        let cs = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(
            data: nil,
            width: targetW,
            height: targetH,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: cs,
            bitmapInfo: bitmapInfo)
        else { return nil }

        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: targetW, height: targetH))
        return ctx.makeImage()
    }

    private nonisolated static func exportToMP4(inputURL: URL, outputURL: URL) async throws {
        let asset = AVAsset(url: inputURL)
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else {
            throw CameraError.exportFailed("Failed to create export session")
        }
        export.outputURL = outputURL
        export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = true

        await withCheckedContinuation { cont in
            export.exportAsynchronously {
                cont.resume()
            }
        }

        switch export.status {
        case .completed:
            return
        case .failed:
            throw CameraError.exportFailed(export.error?.localizedDescription ?? "export failed")
        case .cancelled:
            throw CameraError.exportFailed("export cancelled")
        default:
            throw CameraError.exportFailed("export did not complete (\(export.status.rawValue))")
        }
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private var cont: CheckedContinuation<Data, Error>?

    init(_ cont: CheckedContinuation<Data, Error>) {
        self.cont = cont
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?)
    {
        guard let cont else { return }
        self.cont = nil
        if let error {
            cont.resume(throwing: error)
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            cont.resume(throwing: CameraCaptureService.CameraError.captureFailed("No photo data"))
            return
        }
        cont.resume(returning: data)
    }
}

private final class MovieFileDelegate: NSObject, AVCaptureFileOutputRecordingDelegate {
    private var cont: CheckedContinuation<URL, Error>?
    private let logger: Logger

    init(_ cont: CheckedContinuation<URL, Error>, logger: Logger) {
        self.cont = cont
        self.logger = logger
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?)
    {
        guard let cont else { return }
        self.cont = nil

        if let error {
            let ns = error as NSError
            if ns.domain == AVFoundationErrorDomain,
               ns.code == AVError.maximumDurationReached.rawValue
            {
                cont.resume(returning: outputFileURL)
                return
            }

            self.logger.error("camera record failed: \(error.localizedDescription, privacy: .public)")
            cont.resume(throwing: error)
            return
        }

        cont.resume(returning: outputFileURL)
    }
}
