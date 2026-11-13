import Foundation

/// Closed command accepted by native Dashboard bridges; never a generic RPC or token setter.
public struct GatewayProfileEnrollment: Codable, Sendable {
    public let deviceId: String?
    public let profileId: String?
    public let enrollmentId: String?
    public let name: String?

    public func validate() throws {
        guard (self.profileId != nil) != (self.enrollmentId != nil),
              self.profileId?.isEmpty != true, self.deviceId?.isEmpty != true,
              self.enrollmentId.map({ UUID(uuidString: $0) != nil }) ?? true,
              self.name.map({ $0.count <= 256 }) ?? true,
              self.profileId == nil || self.name == nil
        else { throw CancellationError() }
    }
}

public struct GatewayProfileEnrollmentResult: Codable, Sendable {
    public struct OperatorToken: Codable, Sendable {
        public let token: String
        public let scopes: [String]
    }

    public let deviceId: String
    public let profileId: String
    public let operatorToken: OperatorToken?
}
