import Foundation

public enum SmartAgentNeoCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum SmartAgentNeoCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum SmartAgentNeoCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum SmartAgentNeoCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct SmartAgentNeoCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: SmartAgentNeoCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: SmartAgentNeoCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: SmartAgentNeoCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: SmartAgentNeoCameraImageFormat? = nil,
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

public struct SmartAgentNeoCameraClipParams: Codable, Sendable, Equatable {
    public var facing: SmartAgentNeoCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: SmartAgentNeoCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: SmartAgentNeoCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: SmartAgentNeoCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
