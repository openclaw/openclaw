import Foundation

public enum ChatSendStatus {
    public enum Acceptance: Equatable {
        case inFlight
        case terminalSuccess
        case terminalFailure
    }

    public static func acceptance(of status: String) -> Acceptance {
        switch self.normalized(status) {
        case "ok":
            .terminalSuccess
        case "error", "timeout":
            .terminalFailure
        default:
            .inFlight
        }
    }

    public static func normalized(_ status: String) -> String {
        status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
