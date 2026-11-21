enum TalkGatewayPermissionState: Equatable {
    case unknown
    case ready
    case missingScope(String)
    case requestingUpgrade
    case upgradeRequested
    case requestFailed(String)
    case apiKeyMissing
    case loadFailed(String)

    var requiresTalkPermissionAction: Bool {
        switch self {
        case .missingScope, .requestingUpgrade, .upgradeRequested, .requestFailed:
            true
        default:
            false
        }
    }

    var isApprovalRequestInProgress: Bool {
        switch self {
        case .requestingUpgrade, .upgradeRequested:
            true
        default:
            false
        }
    }
}
