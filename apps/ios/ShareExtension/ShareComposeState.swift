import Foundation
import OpenClawProtocol

/// A successful RPC from an older Gateway is only an acknowledgement, not admission.
/// Keep the draft until the owner explicitly confirms that it handled this request.
enum ShareSendAdmissionError: LocalizedError, Equatable {
    case unconfirmed
    case rejected(String?)

    static func requireAccepted(_ data: Data) throws {
        guard let result = try? JSONDecoder().decode(NodeEventResult.self, from: data),
              result.event == "agent.request"
        else {
            throw unconfirmed
        }
        guard result.ok, result.handled else {
            throw Self.rejected(result.reason)
        }
    }

    var errorDescription: String? {
        switch self {
        case .unconfirmed:
            NSLocalizedString(
                "Gateway admission could not be confirmed. Check OpenClaw before retrying, and update your Gateway.",
                comment: "Share extension legacy or unknown admission result")
        case .rejected("message_too_large"):
            NSLocalizedString(
                "The message is too long. Shorten it and try again.",
                comment: "Share extension oversized message rejection")
        case .rejected("invalid_attachments"):
            NSLocalizedString(
                "The Gateway could not accept the attachments. Remove them and share again.",
                comment: "Share extension attachment rejection")
        case .rejected:
            NSLocalizedString(
                "The Gateway did not accept this request. Check your connection and selected session, then try again.",
                comment: "Share extension request rejection")
        }
    }
}

/// Lifecycle of the share compose card. Failure carries the already-localized
/// message so the footer can surface it verbatim.
enum ShareComposeStatus: Equatable {
    case preparing
    case ready
    case sending
    case sent
    case blocked(String)
    case failed(String)
}

/// Derived control availability for a compose status. Kept UIKit-free so the
/// logic-test target can assert the state machine without instantiating views.
struct ShareComposeControlState: Equatable {
    var isSendEnabled: Bool
    var isCancelEnabled: Bool
    var isEditable: Bool

    static func resolve(status: ShareComposeStatus, hasDraftText: Bool) -> Self {
        switch status {
        case .preparing:
            // Editing stays locked until extraction lands; prepareDraft() replaces
            // the draft wholesale and must not discard text typed mid-preparation.
            Self(isSendEnabled: false, isCancelEnabled: true, isEditable: false)
        case .ready, .failed:
            Self(isSendEnabled: hasDraftText, isCancelEnabled: true, isEditable: true)
        case .blocked:
            Self(isSendEnabled: false, isCancelEnabled: true, isEditable: true)
        case .sending, .sent:
            Self(isSendEnabled: false, isCancelEnabled: false, isEditable: false)
        }
    }
}
