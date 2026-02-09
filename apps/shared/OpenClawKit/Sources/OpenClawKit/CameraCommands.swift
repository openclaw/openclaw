import Foundation

public enum EasyHubCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum EasyHubCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum EasyHubCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum EasyHubCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct EasyHubCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: EasyHubCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: EasyHubCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: EasyHubCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: EasyHubCameraImageFormat? = nil,
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

public struct EasyHubCameraClipParams: Codable, Sendable, Equatable {
    public var facing: EasyHubCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: EasyHubCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: EasyHubCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: EasyHubCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
