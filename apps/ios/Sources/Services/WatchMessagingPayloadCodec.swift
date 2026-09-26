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

    static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
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
        payload["promptId"] = self.nonEmpty(params.promptId)
        payload["sessionKey"] = self.nonEmpty(params.sessionKey)
        payload["gatewayStableID"] = GatewayStableIdentifier.exact(gatewayStableID)
        if let chatDeliveryContext,
           let context = try? OpenClawWatchChatDeliveryCodec.encode(chatDeliveryContext)
        {
            payload["sessionKey"] = chatDeliveryContext.sessionKey
            payload["gatewayStableID"] = chatDeliveryContext.gatewayStableID
            payload["chatDeliveryContext"] = context
        }
        payload["kind"] = self.nonEmpty(params.kind)
        payload["details"] = self.nonEmpty(params.details)
        payload["expiresAtMs"] = params.expiresAtMs
        payload["risk"] = params.risk?.rawValue
        if let actions = params.actions, !actions.isEmpty {
            payload["actions"] = actions.map { action in
                var encoded: [String: Any] = [
                    "id": action.id,
                    "label": action.label,
                ]
                encoded["style"] = self.nonEmpty(action.style)
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
        payload["commandPreview"] = self.nonEmpty(item.commandPreview)
        payload["warningText"] = self.nonEmpty(item.warningText)
        payload["host"] = self.nonEmpty(item.host)
        payload["nodeId"] = self.nonEmpty(item.nodeId)
        payload["agentId"] = self.nonEmpty(item.agentId)
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
        payload["source"] = self.nonEmpty(message.source)
        payload["outcomeText"] = self.nonEmpty(message.outcomeText)
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
        payload["snapshotId"] = self.nonEmpty(message.snapshotId)
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
        payload["agentAvatarUrl"] = self.nonEmpty(message.agentAvatarURL)
        payload["agentAvatarText"] = self.nonEmpty(message.agentAvatarText)
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
        payload["chatStatusText"] = self.nonEmpty(message.chatStatusText)
        payload["snapshotId"] = self.nonEmpty(message.snapshotId)
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
            try .chatDeliveryCommand(OpenClawWatchChatDeliveryCodec.decodeCommandStructure(payload))
        case OpenClawWatchPayloadType.chatDeliveryReceiptAck.rawValue:
            try .chatDeliveryReceiptAck(OpenClawWatchChatDeliveryCodec.decodeReceiptAck(payload))
        case OpenClawWatchPayloadType.reply.rawValue:
            .legacyChat
        case OpenClawWatchPayloadType.execApprovalResolve.rawValue:
            self.parseExecApprovalResolvePayload(payload, transport: transport)
                .map(WatchMessagingInboundEvent.execApprovalResolve)
        case OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue:
            self.parseExecApprovalSnapshotRequestPayload(payload, transport: transport)
                .map(WatchMessagingInboundEvent.execApprovalSnapshotRequest)
        case OpenClawWatchPayloadType.appSnapshotRequest.rawValue:
            self.parseAppSnapshotRequestPayload(payload, transport: transport)
                .map(WatchMessagingInboundEvent.appSnapshotRequest)
        case OpenClawWatchPayloadType.appCommand.rawValue:
            if self.nonEmpty(payload["command"] as? String) == OpenClawWatchAppCommand.sendChat.rawValue {
                .legacyChat
            } else {
                self.parseAppCommandPayload(payload, transport: transport)
                    .map(WatchMessagingInboundEvent.appCommand)
            }
        default:
            nil
        }
    }

    static func parseExecApprovalResolvePayload(
        _ payload: [String: Any],
        transport: String) -> WatchExecApprovalResolveEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.execApprovalResolve.rawValue else {
            return nil
        }
        guard let approvalId = ExecApprovalIdentifier.exact(payload["approvalId"] as? String),
              let rawDecision = nonEmpty(payload["decision"] as? String),
              let decision = OpenClawWatchExecApprovalDecision(rawValue: rawDecision)
        else {
            return nil
        }
        let replyId = ExactOpaqueIdentifier.exact(payload["replyId"] as? String) ?? UUID().uuidString
        let gatewayStableID = GatewayStableIdentifier.exact(payload["gatewayStableID"] as? String)
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        return WatchExecApprovalResolveEvent(
            replyId: replyId,
            approvalId: approvalId,
            gatewayStableID: gatewayStableID,
            decision: decision,
            sentAtMs: sentAtMs,
            transport: transport)
    }

    static func parseExecApprovalSnapshotRequestPayload(
        _ payload: [String: Any],
        transport: String) -> WatchExecApprovalSnapshotRequestEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue else {
            return nil
        }
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
        return WatchExecApprovalSnapshotRequestEvent(
            requestId: requestId,
            gatewayStableID: gatewayStableID,
            heldApprovals: heldApprovals,
            sentAtMs: sentAtMs,
            transport: transport)
    }

    static func parseAppSnapshotRequestPayload(
        _ payload: [String: Any],
        transport: String) -> WatchAppSnapshotRequestEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.appSnapshotRequest.rawValue else {
            return nil
        }
        let requestId = self.nonEmpty(payload["requestId"] as? String) ?? UUID().uuidString
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        return WatchAppSnapshotRequestEvent(
            requestId: requestId,
            sentAtMs: sentAtMs,
            transport: transport)
    }

    static func parseAppCommandPayload(
        _ payload: [String: Any],
        transport: String) -> WatchAppCommandEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.appCommand.rawValue else {
            return nil
        }
        guard let rawCommand = nonEmpty(payload["command"] as? String),
              let command = OpenClawWatchAppCommand(rawValue: rawCommand)
        else {
            return nil
        }
        let commandId = self.nonEmpty(payload["commandId"] as? String) ?? UUID().uuidString
        let sessionKey = self.nonEmpty(payload["sessionKey"] as? String)
        let gatewayStableID = GatewayStableIdentifier.exact(payload["gatewayStableID"] as? String)
        let text = self.nonEmpty(payload["text"] as? String)
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        return WatchAppCommandEvent(
            commandId: commandId,
            command: command,
            sessionKey: sessionKey,
            gatewayStableID: gatewayStableID,
            text: text,
            sentAtMs: sentAtMs,
            transport: transport)
    }
}
