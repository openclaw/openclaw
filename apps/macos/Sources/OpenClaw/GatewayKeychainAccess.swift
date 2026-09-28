import Security

/// Shares a denied authorization across Gateway registry reads and writes.
struct GatewayKeychainAccess {
    private var deniedStatus: OSStatus?

    mutating func allowRetry() {
        self.deniedStatus = nil
    }

    mutating func perform(_ operation: () -> OSStatus) -> OSStatus {
        if let deniedStatus { return deniedStatus }
        let status = operation()
        switch status {
        case errSecUserCanceled, errSecAuthFailed:
            self.deniedStatus = status
        default:
            // Interaction can be temporarily unavailable without the user denying access.
            break
        }
        return status
    }
}
