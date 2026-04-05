import Foundation

public enum MullusiCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum MullusiCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum MullusiCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum MullusiCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct MullusiCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: MullusiCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: MullusiCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: MullusiCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: MullusiCameraImageFormat? = nil,
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

public struct MullusiCameraClipParams: Codable, Sendable, Equatable {
    public var facing: MullusiCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: MullusiCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: MullusiCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: MullusiCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
