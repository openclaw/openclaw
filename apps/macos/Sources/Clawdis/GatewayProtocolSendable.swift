import ClawdisProtocol

// The generated gateway protocol models are value types, but they don't currently declare Sendable.
// We use them across actors via GatewayConnection's event stream, so mark them as unchecked.
extension HelloOk: @unchecked Sendable {}
extension EventFrame: @unchecked Sendable {}

