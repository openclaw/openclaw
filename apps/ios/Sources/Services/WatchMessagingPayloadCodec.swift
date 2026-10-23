import Foundation
import OpenClawKit

enum WatchMessagingInboundEvent: Sendable {
    case chatDeliveryCommand(OpenClawWatchChatDeliveryCommand)
    case chatDeliveryReceiptAck(OpenClawWatchChatDeliveryReceiptAck)
    case legacyChat
    case execApprovalResolve(WatchExecApprovalResolveEvent)
    case execApprovalSnapshotRequest(WatchExecApprovalSnapshotRequestEvent)
    case appSnapshotRequest(WatchAppSnapshotRequestEvent)
    case appCommand(WatchAppCommandEvent)
}

enum WatchMessagingPayloadCodec {
    private static let durableSnapshotTypes = [
        OpenClawWatchPayloadType.appSnapshot.rawValue,
        OpenClawWatchPayloadType.execApprovalSnapshot.rawValue,
    ]

    static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    static func encodeNotificationPayload(
        id: String,
        params: OpenClawWatchNotifyParams,
        gatewayStableID: String?,
        chatDeliveryContext: OpenClawWatchChatDeliveryContext? = nil) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.notify.rawValue,
            "id": id,
            "title": params.title,
            "body": params.body,
            "priority": params.priority?.rawValue ?? OpenClawNotificationPriority.active.rawValue,
            "sentAtMs": self.nowMs(),
        ]
        payload["promptId"] = params.promptId?.trimmedNonEmpty
        payload["sessionKey"] = params.sessionKey?.trimmedNonEmpty
        payload["gatewayStableID"] = GatewayStableIdentifier.exact(gatewayStableID)
        if let chatDeliveryContext,
           let context = try? OpenClawWatchChatDeliveryCodec.encode(chatDeliveryContext)
        {
            payload["sessionKey"] = chatDeliveryContext.sessionKey
            payload["gatewayStableID"] = chatDeliveryContext.gatewayStableID
            payload["chatDeliveryContext"] = context
        }
        payload["kind"] = params.kind?.trimmedNonEmpty
        payload["details"] = params.details?.trimmedNonEmpty
        payload["expiresAtMs"] = params.expiresAtMs
        payload["risk"] = params.risk?.rawValue
        if let actions = params.actions, !actions.isEmpty {
            payload["actions"] = actions.map { action in
                var encoded: [String: Any] = [
                    "id": action.id,
                    "label": action.label,
                ]
                encoded["style"] = action.style?.trimmedNonEmpty
                return encoded
            }
        }
        return payload
    }

    static func encodeDirectNodeSetupPayload(setupCode: String) -> [String: Any] {
        [
            "type": OpenClawWatchPayloadType.directNodeSetup.rawValue,
            "setupCode": setupCode,
            "sentAtMs": self.nowMs(),
        ]
    }

    static func encodeExecApprovalItem(_ item: OpenClawWatchExecApprovalItem) -> [String: Any] {
        var payload: [String: Any] = [
            "id": item.id,
            "commandText": item.commandText,
            "allowedDecisions": item.allowedDecisions.map(\.rawValue),
        ]
        payload["gatewayStableID"] = GatewayStableIdentifier.exact(item.gatewayStableID)
        payload["commandPreview"] = item.commandPreview?.trimmedNonEmpty
        payload["warningText"] = item.warningText?.trimmedNonEmpty
        payload["host"] = item.host?.trimmedNonEmpty
        payload["nodeId"] = item.nodeId?.trimmedNonEmpty
        payload["agentId"] = item.agentId?.trimmedNonEmpty
        payload["expiresAtMs"] = item.expiresAtMs
        payload["risk"] = item.risk?.rawValue
        return payload
    }

    static func encodeExecApprovalPromptPayload(
        _ message: OpenClawWatchExecApprovalPromptMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.execApprovalPrompt.rawValue,
            "approval": self.encodeExecApprovalItem(message.approval),
        ]
        payload["sentAtMs"] = message.sentAtMs
        payload["resetResolutionAttemptId"] = ExactOpaqueIdentifier.exact(message.resetResolutionAttemptId)
        return payload
    }

    static func encodeExecApprovalResolvedPayload(
        _ message: OpenClawWatchExecApprovalResolvedMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.execApprovalResolved.rawValue,
            "approvalId": message.approvalId,
        ]
        payload["gatewayStableID"] = GatewayStableIdentifier.exact(message.gatewayStableID)
        payload["decision"] = message.decision?.rawValue
        payload["outcome"] = message.outcome?.rawValue
        payload["resolvedAtMs"] = message.resolvedAtMs
        payload["source"] = message.source?.trimmedNonEmpty
        payload["outcomeText"] = message.outcomeText?.trimmedNonEmpty
        return payload
    }

    static func encodeExecApprovalExpiredPayload(
        _ message: OpenClawWatchExecApprovalExpiredMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.execApprovalExpired.rawValue,
            "approvalId": message.approvalId,
            "reason": message.reason.rawValue,
        ]
        payload["gatewayStableID"] = GatewayStableIdentifier.exact(message.gatewayStableID)
        payload["expiredAtMs"] = message.expiredAtMs
        return payload
    }

    static func encodeExecApprovalSnapshotPayload(
        _ message: OpenClawWatchExecApprovalSnapshotMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.execApprovalSnapshot.rawValue,
            "approvals": message.approvals.map(self.encodeExecApprovalItem),
        ]
        payload["gatewayStableID"] = GatewayStableIdentifier.exact(message.gatewayStableID)
        payload["sentAtMs"] = message.sentAtMs
        payload["snapshotId"] = message.snapshotId?.trimmedNonEmpty
        payload["requestId"] = ExactOpaqueIdentifier.exact(message.requestId)
        payload["requestGatewayStableID"] = GatewayStableIdentifier.exact(message.requestGatewayStableID)
        return payload
    }

    static func encodeAppSnapshotPayload(
        _ message: OpenClawWatchAppSnapshotMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.appSnapshot.rawValue,
            "gatewayStatus": self.encodeAppStatus(message.gatewayStatus),
            "gatewayStatusText": message.gatewayStatusText,
            "gatewayConnected": message.gatewayConnected,
            "agentName": message.agentName,
            "sessionKey": message.sessionKey,
            "talkStatus": self.encodeAppStatus(message.talkStatus),
            "talkStatusText": message.talkStatusText,
            "talkEnabled": message.talkEnabled,
            "talkListening": message.talkListening,
            "talkSpeaking": message.talkSpeaking,
            "pendingApprovalCount": message.pendingApprovalCount,
        ]
        payload["agentAvatarUrl"] = message.agentAvatarURL?.trimmedNonEmpty
        payload["agentAvatarText"] = message.agentAvatarText?.trimmedNonEmpty
        payload["gatewayStableID"] = GatewayStableIdentifier.exact(message.gatewayStableID)
        payload["sentAtMs"] = message.sentAtMs
        payload["chatItems"] = message.chatItems?.map { item in
            var encoded: [String: Any] = [
                "id": item.id,
                "role": item.role,
                "text": item.text,
            ]
            encoded["timestampMs"] = item.timestampMs
            return encoded
        }
        payload["chatStatus"] = message.chatStatus.map(self.encodeAppStatus)
        payload["chatStatusText"] = message.chatStatusText?.trimmedNonEmpty
        payload["snapshotId"] = message.snapshotId?.trimmedNonEmpty
        if let context = message.chatDeliveryContext,
           let encoded = try? OpenClawWatchChatDeliveryCodec.encode(context)
        {
            payload["chatDeliveryContext"] = encoded
        }
        return payload
    }

    private static func encodeAppStatus(_ status: OpenClawWatchAppStatus) -> [String: Any] {
        var payload: [String: Any] = ["code": status.code.rawValue]
        payload["localizationKey"] = ExactOpaqueIdentifier.exact(status.localizationKey)
        if !status.arguments.isEmpty {
            payload["arguments"] = status.arguments
        }
        payload["verbatim"] = ExactOpaqueIdentifier.exact(status.verbatim)
        return payload
    }

    static func encodeSnapshotApplicationContext(
        _ payload: [String: Any],
        merging existingContext: [String: Any]) -> [String: Any]
    {
        guard let payloadType = payload["type"] as? String,
              self.durableSnapshotTypes.contains(payloadType)
        else {
            return payload
        }

        // updateApplicationContext retains one dictionary. Nest both logical snapshots while
        // keeping the newest one at the top level for older Watch app versions.
        var context = payload
        for snapshotType in self.durableSnapshotTypes {
            if snapshotType == payloadType {
                context[snapshotType] = payload
            } else if let previous = existingContext[snapshotType] as? [String: Any] {
                context[snapshotType] = previous
            } else if existingContext["type"] as? String == snapshotType {
                context[snapshotType] = existingContext
            }
        }
        return context
    }

    static func parseInboundPayload(
        _ payload: [String: Any],
        transport: String) throws -> WatchMessagingInboundEvent?
    {
        switch payload["type"] as? String {
        case OpenClawWatchPayloadType.chatDeliveryCommand.rawValue:
            return try .chatDeliveryCommand(OpenClawWatchChatDeliveryCodec.decodeCommandStructure(payload))
        case OpenClawWatchPayloadType.chatDeliveryReceiptAck.rawValue:
            return try .chatDeliveryReceiptAck(OpenClawWatchChatDeliveryCodec.decodeReceiptAck(payload))
        case OpenClawWatchPayloadType.reply.rawValue:
            return .legacyChat
        case OpenClawWatchPayloadType.execApprovalResolve.rawValue:
            guard let approvalId = ExecApprovalIdentifier.exact(payload["approvalId"] as? String),
                  let rawDecision = (payload["decision"] as? String)?.trimmedNonEmpty,
                  let decision = OpenClawWatchExecApprovalDecision(rawValue: rawDecision)
            else {
                return nil
            }
            let replyId = ExactOpaqueIdentifier.exact(payload["replyId"] as? String) ?? UUID().uuidString
            let gatewayStableID = GatewayStableIdentifier.exact(payload["gatewayStableID"] as? String)
            let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
            return .execApprovalResolve(WatchExecApprovalResolveEvent(
                replyId: replyId,
                approvalId: approvalId,
                gatewayStableID: gatewayStableID,
                decision: decision,
                sentAtMs: sentAtMs,
                transport: transport))
        case OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue:
            // Version-skew compat: shipped Watch binaries request snapshots without requestId or
            // heldApprovals. A missing key decodes as the shipped shape (present-but-malformed
            // still rejects); remove once the minimum paired Watch app version sends heldApprovals.
            let requestId = ExactOpaqueIdentifier.exact(payload["requestId"] as? String) ?? UUID().uuidString
            let rawHeldApprovals: [Any]
            if let rawHeldApprovalsValue = payload["heldApprovals"] {
                guard let heldApprovalsArray = rawHeldApprovalsValue as? [Any] else { return nil }
                rawHeldApprovals = heldApprovalsArray
            } else {
                rawHeldApprovals = []
            }
            var heldApprovals: [WatchExecApprovalSnapshotRequestItem] = []
            heldApprovals.reserveCapacity(rawHeldApprovals.count)
            for rawItem in rawHeldApprovals {
                guard let item = rawItem as? [String: Any],
                      let approvalId = ExecApprovalIdentifier.exact(item["approvalId"] as? String)
                else {
                    return nil
                }
                let activeResolutionAttemptId: String?
                if let rawAttemptId = item["activeResolutionAttemptId"] {
                    guard let attemptId = ExactOpaqueIdentifier.exact(rawAttemptId as? String) else {
                        return nil
                    }
                    activeResolutionAttemptId = attemptId
                } else {
                    activeResolutionAttemptId = nil
                }
                heldApprovals.append(WatchExecApprovalSnapshotRequestItem(
                    approvalId: approvalId,
                    activeResolutionAttemptId: activeResolutionAttemptId))
            }
            let gatewayStableID = GatewayStableIdentifier.exact(payload["gatewayStableID"] as? String)
            let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
            return .execApprovalSnapshotRequest(WatchExecApprovalSnapshotRequestEvent(
                requestId: requestId,
                gatewayStableID: gatewayStableID,
                heldApprovals: heldApprovals,
                sentAtMs: sentAtMs,
                transport: transport))
        case OpenClawWatchPayloadType.appSnapshotRequest.rawValue:
            let requestId = (payload["requestId"] as? String)?.trimmedNonEmpty ?? UUID().uuidString
            let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
            return .appSnapshotRequest(WatchAppSnapshotRequestEvent(
                requestId: requestId,
                sentAtMs: sentAtMs,
                transport: transport))
        case OpenClawWatchPayloadType.appCommand.rawValue:
            if (payload["command"] as? String)?.trimmedNonEmpty == OpenClawWatchAppCommand.sendChat.rawValue {
                return .legacyChat
            }
            guard let rawCommand = (payload["command"] as? String)?.trimmedNonEmpty,
                  let command = OpenClawWatchAppCommand(rawValue: rawCommand)
            else {
                return nil
            }
            let commandId = (payload["commandId"] as? String)?.trimmedNonEmpty ?? UUID().uuidString
            let sessionKey = (payload["sessionKey"] as? String)?.trimmedNonEmpty
            let gatewayStableID = GatewayStableIdentifier.exact(payload["gatewayStableID"] as? String)
            let text = (payload["text"] as? String)?.trimmedNonEmpty
            let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
            return .appCommand(WatchAppCommandEvent(
                commandId: commandId,
                command: command,
                sessionKey: sessionKey,
                gatewayStableID: gatewayStableID,
                text: text,
                sentAtMs: sentAtMs,
                transport: transport))
        default:
            return nil
        }
    }
}
