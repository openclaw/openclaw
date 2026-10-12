import Foundation

extension GatewayProcessManager {
    enum GatewayReadinessPurpose {
        case attach
        case launchd
        case child
        case audit
    }

    enum GatewayProbeFailureDisposition: Equatable {
        case retryWithoutRepair
        case retryWithRepair
        case fail
    }

    enum GatewayReadinessDeadlinePolicy {
        case startup(timeout: TimeInterval)
        case fixed(timeout: TimeInterval)
    }

    enum Status: Equatable {
        case stopped
        case starting
        case running(details: String?)
        case attachedExisting(details: String?)
        case failed(String)

        var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .starting: return "Starting…"
            case let .running(details):
                if let details, !details.isEmpty { return "Running (\(details))" }
                return "Running"
            case let .attachedExisting(details):
                if let details, !details.isEmpty {
                    return "Using existing gateway (\(details))"
                }
                return "Using existing gateway"
            case let .failed(reason): return "Failed: \(reason)"
            }
        }
    }

    nonisolated static func profileAllowsExistingGatewayAttachment(
        profile: AppProfile,
        listenerPID: Int32?,
        managedServicePID: Int32?) -> Bool
    {
        guard profile.isActive else { return true }
        guard let listenerPID, let managedServicePID else { return false }
        return listenerPID == managedServicePID
    }
}
