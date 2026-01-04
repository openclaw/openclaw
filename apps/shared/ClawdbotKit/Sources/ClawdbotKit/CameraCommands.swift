import Foundation

public enum ClawdbotCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum ClawdbotCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum ClawdbotCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum ClawdbotCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct ClawdbotCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: ClawdbotCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: ClawdbotCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: ClawdbotCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: ClawdbotCameraImageFormat? = nil,
        deviceId: String? = nil,
        delayMs: Int? = nil)
    {
        self.facing = facing
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
        self.deviceId = deviceId
        self.delayMs = delayMs
    }
}

public struct ClawdbotCameraClipParams: Codable, Sendable, Equatable {
    public var facing: ClawdbotCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: ClawdbotCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: ClawdbotCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: ClawdbotCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
