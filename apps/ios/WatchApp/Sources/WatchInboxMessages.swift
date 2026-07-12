import Foundation
import OpenClawKit

// Canonical transport leaf models live in OpenClawKit. The local envelope types
// below retain the existing Watch inbox persistence shape without `type`.
typealias WatchPayloadType = OpenClawWatchPayloadType
typealias WatchRiskLevel = OpenClawWatchRisk
typealias WatchExecApprovalDecision = OpenClawWatchExecApprovalDecision
typealias WatchExecApprovalCloseReason = OpenClawWatchExecApprovalCloseReason
typealias WatchOpaqueUTF8Key = ExactOpaqueIdentifierKey
typealias WatchApprovalID = ExecApprovalIdentifier
typealias WatchGatewayID = GatewayStableIdentifier

struct WatchExecApprovalIdentityKey: Hashable, Sendable {
    var gatewayID: WatchGatewayID.Key
    var approvalID: WatchApprovalID.Key
}

typealias WatchExecApprovalItem = OpenClawWatchExecApprovalItem

struct WatchExecApprovalPromptMessage: Codable, Equatable {
    var approval: WatchExecApprovalItem
    var sentAtMs: Int64?
    var resetResolutionAttemptId: String?
}

struct WatchExecApprovalResolvedMessage: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String?
    var decision: WatchExecApprovalDecision?
    var resolvedAtMs: Int64?
    var source: String?
    var outcomeText: String?
}

struct WatchExecApprovalExpiredMessage: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String?
    var reason: WatchExecApprovalCloseReason
    var expiredAtMs: Int64?
}

struct WatchExecApprovalSnapshotMessage: Codable, Equatable {
    var approvals: [WatchExecApprovalItem]
    var gatewayStableID: String?
    var sentAtMs: Int64?
    var snapshotId: String?
    var requestId: String?
    var requestGatewayStableID: String?

    init(
        approvals: [WatchExecApprovalItem],
        gatewayStableID: String? = nil,
        sentAtMs: Int64? = nil,
        snapshotId: String? = nil,
        requestId: String? = nil,
        requestGatewayStableID: String? = nil)
    {
        self.approvals = approvals
        self.gatewayStableID = gatewayStableID
        self.sentAtMs = sentAtMs
        self.snapshotId = snapshotId
        self.requestId = requestId
        self.requestGatewayStableID = requestGatewayStableID
    }
}

typealias WatchExecApprovalSnapshotRequestMessage = OpenClawWatchExecApprovalSnapshotRequestMessage
typealias WatchExecApprovalSnapshotRequestItem = OpenClawWatchExecApprovalSnapshotRequestItem
typealias WatchExecApprovalResolveMessage = OpenClawWatchExecApprovalResolveMessage

struct WatchAppSnapshotMessage: Codable, Equatable {
    var gatewayStatusText: String
    var gatewayConnected: Bool
    var agentName: String
    var agentAvatarURL: String?
    var agentAvatarText: String?
    var sessionKey: String
    var gatewayStableID: String?
    var talkStatusText: String
    var talkEnabled: Bool
    var talkListening: Bool
    var talkSpeaking: Bool
    var pendingApprovalCount: Int
    var chatItems: [WatchChatItem]?
    var chatStatusCode: OpenClawWatchChatStatusCode?
    var chatStatusText: String?
    var sentAtMs: Int64?
    var snapshotId: String?

    static func parsePayload(_ payload: [String: Any]) -> Self? {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.appSnapshot.rawValue
        else {
            return nil
        }
        let gatewayStatusText = (payload["gatewayStatusText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let agentName = (payload["agentName"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let agentAvatarURL = (payload["agentAvatarUrl"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let agentAvatarText = (payload["agentAvatarText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sessionKey = (payload["sessionKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayStableID = WatchGatewayID.exact(payload["gatewayStableID"] as? String)
        let talkStatusText = (payload["talkStatusText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let pendingApprovalCount = (payload["pendingApprovalCount"] as? Int)
            ?? (payload["pendingApprovalCount"] as? NSNumber)?.intValue
            ?? 0
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        let snapshotId = (payload["snapshotId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let chatItems = (payload["chatItems"] as? [Any])?.compactMap(Self.parseChatItem)
        let chatStatusCode = (payload["chatStatusCode"] as? String)
            .flatMap(OpenClawWatchChatStatusCode.init(rawValue:))
        let chatStatusText = (payload["chatStatusText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Self(
            gatewayStatusText: gatewayStatusText.isEmpty ? "Unknown" : gatewayStatusText,
            gatewayConnected: Self.boolValue(payload["gatewayConnected"]),
            agentName: agentName.isEmpty ? "Main" : agentName,
            agentAvatarURL: agentAvatarURL?.isEmpty == false ? agentAvatarURL : nil,
            agentAvatarText: agentAvatarText?.isEmpty == false ? agentAvatarText : nil,
            sessionKey: sessionKey.isEmpty ? "main" : sessionKey,
            gatewayStableID: gatewayStableID,
            talkStatusText: talkStatusText.isEmpty ? "Off" : talkStatusText,
            talkEnabled: Self.boolValue(payload["talkEnabled"]),
            talkListening: Self.boolValue(payload["talkListening"]),
            talkSpeaking: Self.boolValue(payload["talkSpeaking"]),
            pendingApprovalCount: max(0, pendingApprovalCount),
            chatItems: chatItems,
            chatStatusCode: chatStatusCode,
            chatStatusText: chatStatusText?.isEmpty == false ? chatStatusText : nil,
            sentAtMs: sentAtMs,
            snapshotId: snapshotId)
    }

    static func localizedChatStatusText(
        statusCode: OpenClawWatchChatStatusCode?,
        legacyText: String?,
        chatCount: Int,
        hasAppSnapshot: Bool) -> String
    {
        if let statusCode {
            return switch statusCode {
            case .connectIPhone:
                String(localized: "Connect iPhone chat to read messages")
            case .noMessages:
                String(localized: "No chat messages yet")
            case .unavailable:
                String(localized: "Chat unavailable")
            }
        }
        if let legacyText, !legacyText.isEmpty {
            return legacyText
        }
        if chatCount > 0 {
            return String(
                AttributedString(localized: "^[\(chatCount) recent message](inflect: true)").characters)
        }
        return hasAppSnapshot
            ? String(localized: "No messages synced")
            : String(localized: "Waiting for iPhone")
    }

    private static func parseChatItem(_ item: Any) -> WatchChatItem? {
        guard let dict = item as? [String: Any] else { return nil }
        guard let id = (dict["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty
        else {
            return nil
        }
        let trimmedRole = (dict["role"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let text = (dict["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let text, !text.isEmpty else { return nil }
        let timestampMs = (dict["timestampMs"] as? NSNumber)?.int64Value
        return WatchChatItem(
            id: id,
            role: trimmedRole.isEmpty ? "assistant" : trimmedRole,
            text: text,
            timestampMs: timestampMs)
    }

    private static func boolValue(_ value: Any?) -> Bool {
        if let bool = value as? Bool {
            return bool
        }
        if let number = value as? NSNumber {
            return number.boolValue
        }
        return false
    }
}

typealias WatchChatCompletionMessage = OpenClawWatchChatCompletionMessage
typealias WatchChatItem = OpenClawWatchChatItem
typealias WatchAppSnapshotRequestMessage = OpenClawWatchAppSnapshotRequestMessage
typealias WatchAppCommand = OpenClawWatchAppCommand
typealias WatchAppCommandMessage = OpenClawWatchAppCommandMessage
typealias WatchPromptAction = OpenClawWatchAction

struct WatchNotifyMessage: Codable {
    var id: String?
    var title: String
    var body: String
    var sentAtMs: Int64?
    var promptId: String?
    var sessionKey: String?
    var gatewayStableID: String?
    var kind: String?
    var details: String?
    var expiresAtMs: Int64?
    var risk: String?
    var actions: [WatchPromptAction]
}

struct WatchExecApprovalRecord: Codable, Equatable, Identifiable {
    var approval: WatchExecApprovalItem
    var transport: String
    var sourceSentAtMs: Int64?
    var updatedAt: Date
    var isResolving: Bool
    var pendingDecision: WatchExecApprovalDecision?
    var activeResolutionAttemptID: String?
    var statusText: String?
    var statusAt: Date?

    var id: WatchExecApprovalIdentityKey {
        WatchExecApprovalIdentityKey(
            gatewayID: WatchOpaqueUTF8Key(self.approval.gatewayStableID ?? ""),
            approvalID: WatchOpaqueUTF8Key(self.approval.id))
    }

    var approvalID: String {
        self.approval.id
    }
}
