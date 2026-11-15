import Security

/// Shares a denied authorization across Gateway registry reads and writes.
struct GatewayKeychainAccess {
    private var deniedStatus: OSStatus?

    static func configure(launchPlan: AppLaunchRuntimePlan) -> OSStatus {
        guard !launchPlan.allowsActivation else { return errSecSuccess }
        // These stores use the legacy login Keychain, where query-level authentication
        // options do not suppress SecurityAgent. Keep interaction disabled for this process.
        return SecKeychainSetUserInteractionAllowed(false)
    }

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
