import Foundation

public enum OpenClawNodeErrorCode: String, Codable, Sendable {
    case notPaired = "NOT_PAIRED"
    case unauthorized = "UNAUTHORIZED"
    case backgroundUnavailable = "NODE_BACKGROUND_UNAVAILABLE"
    case invalidRequest = "INVALID_REQUEST"
    case unavailable = "UNAVAILABLE"
    /// Rejected before a command handler or progress frame; safe for bounded admission recovery.
    case notReady = "NODE_NOT_READY"
    case systemRunDenied = "SYSTEM_RUN_DENIED"
    case permissionMissing = "PERMISSION_MISSING"
}

public enum OpenClawPermissionState: String, Codable, Sendable {
    case notDetermined = "not-determined"
    case denied
    case restartRequired = "restart-required"
    case staleGrant = "stale-grant"
    case disabledInOpenClaw = "disabled-in-openclaw"
}

public struct OpenClawPermissionDetails: Codable, Sendable, Equatable {
    public var capabilities: [String]
    public var state: OpenClawPermissionState

    public init(capabilities: [String], state: OpenClawPermissionState) {
        self.capabilities = capabilities
        self.state = state
    }
}

public struct OpenClawNodeError: Error, Codable, Sendable, Equatable {
    public var code: OpenClawNodeErrorCode
    public var message: String
    public var retryable: Bool?
    public var retryAfterMs: Int?
    public var details: OpenClawPermissionDetails?

    public init(
        code: OpenClawNodeErrorCode,
        message: String,
        retryable: Bool? = nil,
        retryAfterMs: Int? = nil,
        details: OpenClawPermissionDetails? = nil)
    {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retryAfterMs = retryAfterMs
        self.details = details
    }
}
