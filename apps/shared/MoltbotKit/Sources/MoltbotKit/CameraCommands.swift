import Foundation

public enum DNACameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum DNACameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum DNACameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum DNACameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct DNACameraSnapParams: Codable, Sendable, Equatable {
    public var facing: DNACameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: DNACameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: DNACameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: DNACameraImageFormat? = nil,
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

public struct DNACameraClipParams: Codable, Sendable, Equatable {
    public var facing: DNACameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: DNACameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: DNACameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: DNACameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
