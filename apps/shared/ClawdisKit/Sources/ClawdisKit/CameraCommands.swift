import Foundation

public enum ClawdisCameraCommand: String, Codable, Sendable {
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum ClawdisCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum ClawdisCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum ClawdisCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct ClawdisCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: ClawdisCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: ClawdisCameraImageFormat?

    public init(
        facing: ClawdisCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: ClawdisCameraImageFormat? = nil)
    {
        self.facing = facing
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
    }
}

public struct ClawdisCameraClipParams: Codable, Sendable, Equatable {
    public var facing: ClawdisCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: ClawdisCameraVideoFormat?

    public init(
        facing: ClawdisCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: ClawdisCameraVideoFormat? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
    }
}
