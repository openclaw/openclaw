import AVFoundation
import ClawdisKit
import Foundation
import UIKit

actor CameraController {
    enum CameraError: LocalizedError, Sendable {
        case cameraUnavailable
        case microphoneUnavailable
        case permissionDenied(kind: String)
        case invalidParams(String)
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
            case let .invalidParams(msg):
                msg
            case let .captureFailed(msg):
                msg
            case let .exportFailed(msg):
                msg
            }
        }
    }

    func snap(params: ClawdisCameraSnapParams) async throws -> (
        format: String,
        base64: String,
        width: Int,
        height: Int)
    {
        let facing = params.facing ?? .front
        let maxWidth = params.maxWidth.flatMap { $0 > 0 ? $0 : nil }
        let quality = Self.clampQuality(params.quality)

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

        let rawData: Data = try await withCheckedThrowingContinuation { cont in
            output.capturePhoto(with: settings, delegate: PhotoCaptureDelegate(cont))
        }

        let (finalData, size) = try Self.reencodeJPEG(
            imageData: rawData,
            maxWidth: maxWidth,
            quality: quality)

        return (
            format: "jpg",
            base64: finalData.base64EncodedString(),
            width: Int(size.width.rounded()),
            height: Int(size.height.rounded()))
    }

    func clip(params: ClawdisCameraClipParams) async throws -> (
        format: String,
        base64: String,
        durationMs: Int,
        hasAudio: Bool)
    {
        let facing = params.facing ?? .front
        let durationMs = Self.clampDurationMs(params.durationMs)
        let includeAudio = params.includeAudio ?? true

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
            if session.canAddInput(micInput) {
                session.addInput(micInput)
            } else {
                throw CameraError.captureFailed("Failed to add microphone input")
            }
        }

        let output = AVCaptureMovieFileOutput()
        guard session.canAddOutput(output) else {
            throw CameraError.captureFailed("Failed to add movie output")
        }
        session.addOutput(output)
        output.maxRecordedDuration = CMTime(value: Int64(durationMs), timescale: 1000)

        session.startRunning()
        defer { session.stopRunning() }

        let movURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-camera-\(UUID().uuidString).mov")
        let mp4URL = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-camera-\(UUID().uuidString).mp4")

        defer {
            try? FileManager.default.removeItem(at: movURL)
            try? FileManager.default.removeItem(at: mp4URL)
        }

        let recordedURL: URL = try await withCheckedThrowingContinuation { cont in
            let delegate = MovieFileDelegate(cont)
            output.startRecording(to: movURL, recordingDelegate: delegate)
        }

        // Transcode .mov -> .mp4 for easier downstream handling.
        try await Self.exportToMP4(inputURL: recordedURL, outputURL: mp4URL)

        let data = try Data(contentsOf: mp4URL)
        return (format: "mp4", base64: data.base64EncodedString(), durationMs: durationMs, hasAudio: includeAudio)
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

    private nonisolated static func pickCamera(facing: ClawdisCameraFacing) -> AVCaptureDevice? {
        let position: AVCaptureDevice.Position = (facing == .front) ? .front : .back
        return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
    }

    private nonisolated static func clampQuality(_ quality: Double?) -> Double {
        let q = quality ?? 0.9
        return min(1.0, max(0.05, q))
    }

    private nonisolated static func clampDurationMs(_ ms: Int?) -> Int {
        let v = ms ?? 3000
        // Keep clips short by default; avoid huge base64 payloads on the bridge.
        return min(15000, max(250, v))
    }

    private nonisolated static func reencodeJPEG(
        imageData: Data,
        maxWidth: Int?,
        quality: Double) throws -> (data: Data, size: CGSize)
    {
        guard let image = UIImage(data: imageData) else {
            throw CameraError.captureFailed("Failed to decode captured image")
        }

        let finalImage: UIImage = if let maxWidth, maxWidth > 0 {
            Self.downscale(image: image, maxWidth: CGFloat(maxWidth))
        } else {
            image
        }

        guard let out = finalImage.jpegData(compressionQuality: quality) else {
            throw CameraError.captureFailed("Failed to encode JPEG")
        }

        return (out, finalImage.size)
    }

    private nonisolated static func downscale(image: UIImage, maxWidth: CGFloat) -> UIImage {
        let w = image.size.width
        let h = image.size.height
        guard w > 0, h > 0 else { return image }
        guard w > maxWidth else { return image }

        let scale = maxWidth / w
        let target = CGSize(width: maxWidth, height: max(1, h * scale))

        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    private nonisolated static func exportToMP4(inputURL: URL, outputURL: URL) async throws {
        let asset = AVAsset(url: inputURL)
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
            throw CameraError.exportFailed("Failed to create export session")
        }
        exporter.outputURL = outputURL
        exporter.outputFileType = .mp4
        exporter.shouldOptimizeForNetworkUse = true

        try await withCheckedThrowingContinuation(isolation: nil) { cont in
            exporter.exportAsynchronously {
                switch exporter.status {
                case .completed:
                    cont.resume(returning: ())
                case .failed:
                    cont.resume(throwing: exporter.error ?? CameraError.exportFailed("Export failed"))
                case .cancelled:
                    cont.resume(throwing: CameraError.exportFailed("Export cancelled"))
                default:
                    cont.resume(throwing: CameraError.exportFailed("Export did not complete"))
                }
            }
        }
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private let continuation: CheckedContinuation<Data, Error>
    private var didResume = false

    init(_ continuation: CheckedContinuation<Data, Error>) {
        self.continuation = continuation
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?)
    {
        guard !self.didResume else { return }
        self.didResume = true

        if let error {
            self.continuation.resume(throwing: error)
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            self.continuation.resume(
                throwing: NSError(domain: "Camera", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "photo data missing",
                ]))
            return
        }
        self.continuation.resume(returning: data)
    }
}

private final class MovieFileDelegate: NSObject, AVCaptureFileOutputRecordingDelegate {
    private let continuation: CheckedContinuation<URL, Error>
    private var didResume = false

    init(_ continuation: CheckedContinuation<URL, Error>) {
        self.continuation = continuation
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?)
    {
        guard !self.didResume else { return }
        self.didResume = true

        if let error {
            self.continuation.resume(throwing: error)
            return
        }
        self.continuation.resume(returning: outputFileURL)
    }
}
