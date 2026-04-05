import Foundation

public enum MullusiNodeErrorCode: String, Codable, Sendable {
    case notPaired = "NOT_PAIRED"
    case unauthorized = "UNAUTHORIZED"
    case backgroundUnavailable = "NODE_BACKGROUND_UNAVAILABLE"
    case invalidRequest = "INVALID_REQUEST"
    case unavailable = "UNAVAILABLE"
}

public struct MullusiNodeError: Error, Codable, Sendable, Equatable {
    public var code: MullusiNodeErrorCode
    public var message: String
    public var retryable: Bool?
    public var retryAfterMs: Int?

    public init(
        code: MullusiNodeErrorCode,
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
