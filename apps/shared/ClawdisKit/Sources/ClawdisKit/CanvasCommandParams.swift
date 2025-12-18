import Foundation

public enum ClawdisCanvasMode: String, Codable, Sendable {
    case canvas
    case web
}

public struct ClawdisCanvasNavigateParams: Codable, Sendable, Equatable {
    public var url: String

    public init(url: String) {
        self.url = url
    }
}

public struct ClawdisCanvasSetModeParams: Codable, Sendable, Equatable {
    public var mode: ClawdisCanvasMode

    public init(mode: ClawdisCanvasMode) {
        self.mode = mode
    }
}

public struct ClawdisCanvasEvalParams: Codable, Sendable, Equatable {
    public var javaScript: String

    public init(javaScript: String) {
        self.javaScript = javaScript
    }
}

public enum ClawdisCanvasSnapshotFormat: String, Codable, Sendable {
    case png
    case jpeg
}

public struct ClawdisCanvasSnapshotParams: Codable, Sendable, Equatable {
    public var maxWidth: Int?
    public var quality: Double?
    public var format: ClawdisCanvasSnapshotFormat?

    public init(maxWidth: Int? = nil, quality: Double? = nil, format: ClawdisCanvasSnapshotFormat? = nil) {
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
    }
}
