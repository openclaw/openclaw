import Foundation

public enum EasyHubNodeErrorCode: String, Codable, Sendable {
    case notPaired = "NOT_PAIRED"
    case unauthorized = "UNAUTHORIZED"
    case backgroundUnavailable = "NODE_BACKGROUND_UNAVAILABLE"
    case invalidRequest = "INVALID_REQUEST"
    case unavailable = "UNAVAILABLE"
}

public struct EasyHubNodeError: Error, Codable, Sendable, Equatable {
    public var code: EasyHubNodeErrorCode
    public var message: String
    public var retryable: Bool?
    public var retryAfterMs: Int?

    public init(
        code: EasyHubNodeErrorCode,
        message: String,
        retryable: Bool? = nil,
        retryAfterMs: Int? = nil)
    {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retryAfterMs = retryAfterMs
    }
}
