import AVFoundation
import CoreMedia
import Foundation

#if !os(watchOS)
public struct CameraMovieSessionOptions: Sendable {
    public let preferFrontCamera: Bool
    public let deviceId: String?
    public let includeAudio: Bool
    public let durationMs: Int

    public init(
        preferFrontCamera: Bool,
        deviceId: String?,
        includeAudio: Bool,
        durationMs: Int)
    {
        self.preferFrontCamera = preferFrontCamera
        self.deviceId = deviceId
        self.includeAudio = includeAudio
        self.durationMs = durationMs
    }
}

/// Device-independent capture dimensions used to pick a landscape format.
public struct CameraCaptureFormatSize: Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    public var isLandscape: Bool { self.width >= self.height }
    public var pixelCount: Int { max(0, self.width) * max(0, self.height) }
}

public enum CameraCapturePipelineSupport {
    public static func preparePhotoSession(
        preferFrontCamera: Bool,
        deviceId: String?,
        pickCamera: (_ preferFrontCamera: Bool, _ deviceId: String?) -> AVCaptureDevice?,
        cameraUnavailableError: @autoclosure () -> Error,
        mapSetupError: (CameraSessionConfigurationError) -> Error) throws
        -> (session: AVCaptureSession, device: AVCaptureDevice, output: AVCapturePhotoOutput)
    {
        let session = AVCaptureSession()
        session.sessionPreset = .photo

        guard let device = pickCamera(preferFrontCamera, deviceId) else {
            throw cameraUnavailableError()
        }

        do {
            try CameraSessionConfiguration.addCameraInput(session: session, camera: device)
            let output = try CameraSessionConfiguration.addPhotoOutput(session: session)
            return (session, device, output)
        } catch let setupError as CameraSessionConfigurationError {
            throw mapSetupError(setupError)
        }
    }

    public static func prepareMovieSession(
        options: CameraMovieSessionOptions,
        pickCamera: (_ preferFrontCamera: Bool, _ deviceId: String?) -> AVCaptureDevice?,
        cameraUnavailableError: @autoclosure () -> Error,
        mapSetupError: (CameraSessionConfigurationError) -> Error) throws
        -> (session: AVCaptureSession, output: AVCaptureMovieFileOutput)
    {
        let session = AVCaptureSession()
        session.sessionPreset = .high

        guard let camera = pickCamera(options.preferFrontCamera, options.deviceId) else {
            throw cameraUnavailableError()
        }

        do {
            try CameraSessionConfiguration.addCameraInput(session: session, camera: camera)
            let output = try CameraSessionConfiguration.addMovieOutput(
                session: session,
                includeAudio: options.includeAudio,
                durationMs: options.durationMs)
            return (session, output)
        } catch let setupError as CameraSessionConfigurationError {
            throw mapSetupError(setupError)
        }
    }

    public static func prepareWarmMovieSession(
        options: CameraMovieSessionOptions,
        pickCamera: (_ preferFrontCamera: Bool, _ deviceId: String?) -> AVCaptureDevice?,
        cameraUnavailableError: @autoclosure () -> Error,
        mapSetupError: (CameraSessionConfigurationError) -> Error) async throws
        -> (session: AVCaptureSession, output: AVCaptureMovieFileOutput)
    {
        try Task.checkCancellation()
        let prepared = try self.prepareMovieSession(
            options: options,
            pickCamera: pickCamera,
            cameraUnavailableError: cameraUnavailableError(),
            mapSetupError: mapSetupError)
        try Task.checkCancellation()
        prepared.session.startRunning()
        do {
            try await self.warmUpCaptureSession()
            try Task.checkCancellation()
        } catch {
            prepared.session.stopRunning()
            throw error
        }
        return prepared
    }

    public static func withWarmMovieSession<T>(
        options: CameraMovieSessionOptions,
        pickCamera: (_ preferFrontCamera: Bool, _ deviceId: String?) -> AVCaptureDevice?,
        cameraUnavailableError: @autoclosure () -> Error,
        mapSetupError: (CameraSessionConfigurationError) -> Error,
        operation: (AVCaptureMovieFileOutput) async throws -> T) async throws -> T
    {
        try Task.checkCancellation()
        let prepared = try self.prepareMovieSession(
            options: options,
            pickCamera: pickCamera,
            cameraUnavailableError: cameraUnavailableError(),
            mapSetupError: mapSetupError)
        return try await self.withCaptureSessionLifecycle(
            start: { prepared.session.startRunning() },
            stop: { prepared.session.stopRunning() },
            warmUp: { try await self.warmUpCaptureSession() },
            operation: { try await operation(prepared.output) })
    }

    static func withCaptureSessionLifecycle<T>(
        start: () -> Void,
        stop: () -> Void,
        warmUp: () async throws -> Void,
        operation: () async throws -> T) async throws -> T
    {
        try Task.checkCancellation()
        start()
        defer { stop() }

        try Task.checkCancellation()
        try await warmUp()
        try Task.checkCancellation()
        return try await operation()
    }

    public static func mapMovieSetupError<E: Error>(
        _ setupError: CameraSessionConfigurationError,
        microphoneUnavailableError: @autoclosure () -> E,
        captureFailed: (String) -> E) -> E
    {
        if case .microphoneUnavailable = setupError {
            return microphoneUnavailableError()
        }
        return captureFailed(setupError.localizedDescription)
    }

    public static func makePhotoSettings(output: AVCapturePhotoOutput) -> AVCapturePhotoSettings {
        let settings: AVCapturePhotoSettings = {
            if output.availablePhotoCodecTypes.contains(.jpeg) {
                return AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            }
            return AVCapturePhotoSettings()
        }()
        settings.photoQualityPrioritization = .quality
        return settings
    }

    public static func warmUpCaptureSession() async throws {
        // A short delay after `startRunning()` significantly reduces "blank first frame" captures on some devices.
        try await Task.sleep(nanoseconds: 150_000_000) // 150ms
    }

    public static func positionLabel(_ position: AVCaptureDevice.Position) -> String {
        switch position {
        case .front: "front"
        case .back: "back"
        default: "unspecified"
        }
    }

    /// Prefer landscape formats after `.photo` / `.high` renegotiation so external
    /// cameras (for example AnkerWork C310) do not stay locked to a portrait mode.
    public static func applyPreferredCaptureFormat(
        device: AVCaptureDevice,
        preferredMaxWidth: Int?) throws
    {
        let sizes = device.formats.map { format in
            let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            return CameraCaptureFormatSize(width: Int(dimensions.width), height: Int(dimensions.height))
        }
        guard let index = Self.selectPreferredCaptureFormatIndex(
            candidates: sizes,
            preferredMaxWidth: preferredMaxWidth)
        else {
            return
        }
        let preferred = device.formats[index]
        if device.activeFormat === preferred {
            return
        }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        device.activeFormat = preferred
    }

    /// Choose the best capture size for gateway snaps: landscape first, then closest
    /// to `preferredMaxWidth`, then highest pixel count.
    public static func selectPreferredCaptureFormatIndex(
        candidates: [CameraCaptureFormatSize],
        preferredMaxWidth: Int?) -> Int?
    {
        guard !candidates.isEmpty else {
            return nil
        }
        let preferredWidth = preferredMaxWidth.flatMap { $0 > 0 ? $0 : nil }
        var bestIndex = 0
        for index in candidates.indices.dropFirst() {
            if Self.isPreferredCaptureFormat(
                candidates[index],
                over: candidates[bestIndex],
                preferredMaxWidth: preferredWidth)
            {
                bestIndex = index
            }
        }
        return bestIndex
    }

    static func isPreferredCaptureFormat(
        _ candidate: CameraCaptureFormatSize,
        over current: CameraCaptureFormatSize,
        preferredMaxWidth: Int?) -> Bool
    {
        if candidate.isLandscape != current.isLandscape {
            return candidate.isLandscape
        }
        if let preferredMaxWidth {
            let candidateDistance = Self.widthDistance(candidate.width, preferredMaxWidth: preferredMaxWidth)
            let currentDistance = Self.widthDistance(current.width, preferredMaxWidth: preferredMaxWidth)
            if candidateDistance != currentDistance {
                return candidateDistance < currentDistance
            }
        }
        if candidate.pixelCount != current.pixelCount {
            return candidate.pixelCount > current.pixelCount
        }
        return candidate.width > current.width
    }

    private static func widthDistance(_ width: Int, preferredMaxWidth: Int) -> Int {
        // Prefer at-or-above the requested width so post-capture downscale keeps detail;
        // undersized formats are a last resort.
        if width >= preferredMaxWidth {
            return width - preferredMaxWidth
        }
        return preferredMaxWidth - width + 1_000_000
    }
}
#endif
