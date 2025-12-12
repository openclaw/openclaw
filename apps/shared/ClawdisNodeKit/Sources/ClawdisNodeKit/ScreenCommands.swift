import Foundation

public enum ClawdisScreenMode: String, Codable, Sendable {
    case canvas
    case web
}

public enum ClawdisScreenCommand: String, Codable, Sendable {
    case show = "screen.show"
    case hide = "screen.hide"
    case setMode = "screen.setMode"
    case navigate = "screen.navigate"
    case evalJS = "screen.eval"
    case snapshot = "screen.snapshot"
}

public struct ClawdisScreenNavigateParams: Codable, Sendable, Equatable {
    public var url: String

    public init(url: String) {
        self.url = url
    }
}

public struct ClawdisScreenSetModeParams: Codable, Sendable, Equatable {
    public var mode: ClawdisScreenMode

    public init(mode: ClawdisScreenMode) {
        self.mode = mode
    }
}

public struct ClawdisScreenEvalParams: Codable, Sendable, Equatable {
    public var javaScript: String

    public init(javaScript: String) {
        self.javaScript = javaScript
    }
}

public enum ClawdisSnapshotFormat: String, Codable, Sendable {
    case png
    case jpeg
}

public struct ClawdisScreenSnapshotParams: Codable, Sendable, Equatable {
    public var maxWidth: Int?
    public var quality: Double?
    public var format: ClawdisSnapshotFormat?

    public init(maxWidth: Int? = nil, quality: Double? = nil, format: ClawdisSnapshotFormat? = nil) {
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
    }
}
