import Foundation
import OpenClawKit
import OpenClawProtocol

public enum OpenClawChatSessionKey {
    public static func matchesIncludingDefaultMainAlias(_ incoming: String, _ current: String) -> Bool {
        let incoming = self.comparisonKey(incoming)
        let current = self.comparisonKey(current)
        if incoming == current {
            return true
        }
        return (incoming == "agent:main:main" && current == "main") ||
            (incoming == "main" && current == "agent:main:main")
    }

    /// Match the Control UI's session-key comparison without folding opaque channel identifiers.
    static func comparisonKey(_ key: String) -> String {
        let raw = key.trimmingCharacters(in: .whitespacesAndNewlines)
        var parts = raw.components(separatedBy: ":")
        var start = 0
        while parts.count - start >= 3, parts[start].lowercased() == "agent" {
            parts[start] = "agent"
            parts[start + 1] = parts[start + 1].lowercased()
            start += 2
        }
        while start < parts.count, parts[start].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            start += 1
        }
        guard start < parts.count else { return raw.lowercased() }
        let channel = parts[start].lowercased()
        if channel == "catalog" { return parts.joined(separator: ":") }
        guard start + 1 < parts.count else { return raw.lowercased() }
        let peer = parts[start + 1].lowercased()
        let matrix = channel == "matrix" && ["channel", "group"].contains(peer)
        guard matrix || (channel == "signal" && peer == "group") else { return raw.lowercased() }
        parts[start] = channel
        parts[start + 1] = peer
        if matrix {
            if let index = parts.indices.reversed().first(where: {
                $0 >= start + 2 && $0 < parts.count - 1 && parts[$0].lowercased() == "thread"
            }) { parts[index] = "thread" }
        } else if start + 2 < parts.count {
            parts[start + 2] = parts[start + 2].trimmingCharacters(in: .whitespacesAndNewlines)
            for index in (start + 3)..<parts.count {
                parts[index] = parts[index].lowercased()
            }
        }
        return parts.joined(separator: ":")
    }

    public static func agentID(from sessionKey: String?) -> String? {
        let parts = (sessionKey ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }
}

/// Canonical gateway payload mapping shared by the native Apple chat transports.
public enum OpenClawChatGatewayPayloadCodec {
    private enum SpeechError: LocalizedError {
        case emptyAudio

        var errorDescription: String? {
            "Gateway tts.speak returned empty audio"
        }
    }

    public static func decodeSpeechClip(_ data: Data) throws -> OpenClawChatSpeechClip {
        let response = try JSONDecoder().decode(TtsSpeakResult.self, from: data)
        guard let audioData = Data(base64Encoded: response.audiobase64), !audioData.isEmpty else {
            throw SpeechError.emptyAudio
        }
        return OpenClawChatSpeechClip(
            data: audioData,
            outputFormat: response.outputformat,
            mimeType: response.mimetype,
            fileExtension: response.fileextension)
    }

    public static func decodeReactionsList(_ data: Data) throws -> OpenClawChatReactionsListResult {
        let result = try JSONDecoder().decode(SessionReactionsListResult.self, from: data)
        return try OpenClawChatReactionsListResult(
            sessionID: result.sessionid,
            reactions: result.reactions.mapValues {
                try GatewayPayloadDecoding.decode($0, as: [OpenClawChatReactionSummary].self)
            })
    }

    public static func decodeReactionsSet(_ data: Data) throws -> OpenClawChatReactionsSetResult {
        let result = try JSONDecoder().decode(SessionReactionsSetResult.self, from: data)
        return try OpenClawChatReactionsSetResult(
            messageID: result.messageid,
            reactions: result.reactions.map(self.reactionSummary))
    }

    private static func reactionSummary(_ summary: MessageReactionSummary) throws -> OpenClawChatReactionSummary {
        try OpenClawChatReactionSummary(
            emoji: summary.emoji,
            count: summary.count,
            identities: summary.identities.map {
                try GatewayPayloadDecoding.decode(AnyCodable($0), as: OpenClawChatReactionIdentity.self)
            })
    }

    private static func reactionEvent(_ event: SessionReactionEvent) throws -> OpenClawChatReactionEvent {
        try OpenClawChatReactionEvent(
            sessionKey: event.sessionkey,
            agentID: event.agentid,
            sessionID: event.sessionid,
            messageID: event.messageid,
            reactions: event.reactions.map(self.reactionSummary))
    }

    public static func decodeSessionsList(_ data: Data, agentID: String?) throws -> OpenClawChatSessionsListResponse {
        var decoded = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        decoded.sessions = decoded.sessions.map { row in
            var row = row
            row.agentId = OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId ?? agentID
            return row
        }
        return decoded
    }

    public static func decodeAgentsList(_ data: Data) throws -> OpenClawChatAgentsListResponse {
        let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
        return OpenClawChatAgentsListResponse(
            defaultId: result.defaultid,
            agents: result.agents.filter(\.isSelectableAgent).map {
                OpenClawChatAgentChoice(
                    id: $0.id,
                    name: OpenClawChatAgentChoice.normalizedName($0.name)
                        ?? OpenClawChatAgentChoice.normalizedName($0.identity?["name"]?.value as? String),
                    emoji: OpenClawChatAgentChoice.textAvatar($0.identity?["emoji"]?.value as? String)
                        ?? OpenClawChatAgentChoice.textAvatar($0.identity?["avatar"]?.value as? String),
                    workspaceGit: $0.workspacegit)
            },
            sessionRoutingContract: OpenClawChatSessionRoutingContract.make(
                scope: result.scope.value as? String,
                mainKey: result.mainkey,
                defaultAgentID: result.defaultid))
    }

    public static func decodeProgressCard(_ data: Data, agentID: String?) throws -> ProgressCard? {
        let result = try JSONDecoder().decode(ProgressCardGetResult.self, from: data)
        guard !(result.card.value is NSNull) else { return nil }
        let card = try GatewayPayloadDecoding.decode(result.card, as: ProgressCard.self)
        if let agentID,
           OpenClawChatSessionKey.agentID(from: card.sessionkey)?.lowercased() != agentID.lowercased()
        {
            throw NSError(domain: "OpenClawChatTransport", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "Progress card response belongs to another agent.",
            ])
        }
        return card
    }

    public static func decodeQuestionAnswer(_ data: Data) throws -> QuestionAnswers {
        struct AnsweredQuestion: Decodable {
            enum Status: String, Decodable { case answered }
            let status: Status
            let answers: QuestionAnswers
        }
        return try JSONDecoder().decode(AnsweredQuestion.self, from: data).answers
    }

    private struct AgentWaitResponse: Decodable {
        var status: String?
        var endedAt: Double?
        var error: String?
        var stopReason: String?
        var livenessState: String?
        var yielded: Bool?
        var pendingError: Bool?
        var timeoutPhase: String?
        var providerStarted: Bool?
        var aborted: Bool?
    }

    public static func decodeAgentWaitObservation(_ data: Data) throws -> OpenClawChatRunObservation {
        let decoded = try JSONDecoder().decode(AgentWaitResponse.self, from: data)
        return OpenClawChatRunObservation.fromWaitResponse(
            status: decoded.status,
            endedAt: decoded.endedAt,
            error: decoded.error,
            stopReason: decoded.stopReason,
            livenessState: decoded.livenessState,
            yielded: decoded.yielded,
            pendingError: decoded.pendingError,
            timeoutPhase: decoded.timeoutPhase,
            providerStarted: decoded.providerStarted,
            aborted: decoded.aborted)
    }

    public static func decodeModelChoices(_ data: Data) throws -> [OpenClawChatModelChoice] {
        let decoded = try JSONDecoder().decode(ModelsListResult.self, from: data)
        return try decoded.models.map(self.modelChoice)
    }

    public static func decodeModelCatalog(_ data: Data) throws -> OpenClawChatModelCatalogSnapshot {
        let decoded = try JSONDecoder().decode(ModelsListResult.self, from: data)
        return try OpenClawChatModelCatalogSnapshot(
            choices: decoded.models.map(self.modelChoice),
            availabilityIsSessionScoped: true,
            refreshFailed: decoded.refreshfailed == true,
            modelSelectionPolicy: decoded.modelselectionpolicy.map {
                try GatewayPayloadDecoding.decode(AnyCodable($0))
            })
    }

    public static func decodeSessionRoutingIdentity(_ data: Data) throws -> OpenClawChatSessionRoutingIdentity {
        let decoded = try JSONDecoder().decode(AgentsListResult.self, from: data)
        guard let identity = OpenClawChatSessionRoutingIdentity(
            scope: decoded.scope.value as? String,
            mainSessionKey: decoded.mainkey,
            defaultAgentID: decoded.defaultid)
        else { throw CancellationError() }
        return identity
    }

    public static func modelChoice(_ model: ModelChoice) throws -> OpenClawChatModelChoice {
        let name = model.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return try OpenClawChatModelChoice(
            modelID: model.id,
            name: name.isEmpty ? model.id : model.name,
            provider: model.provider,
            available: model.available,
            manualSelectionAllowed: model.manualselectionallowed,
            unavailableReason: model.unavailablereason?.value as? String,
            unavailableUntil: model.unavailableuntil,
            contextWindow: model.contextwindow,
            reasoning: model.reasoning,
            supportsFastMode: model.supportsfastmode,
            effectiveFastMode: model.effectivefastmode.map { try GatewayPayloadDecoding.decode($0) },
            thinkingLevels: model.thinkinglevels.map { try GatewayPayloadDecoding.decode(AnyCodable($0)) },
            thinkingDefault: model.thinkingdefault,
            input: model.input.map { try GatewayPayloadDecoding.decode(AnyCodable($0)) },
            agentRuntime: model.agentruntime.map { try GatewayPayloadDecoding.decode(AnyCodable($0)) })
    }

    public static func commandChoice(_ entry: CommandEntry) -> OpenClawChatCommandChoice {
        let sourceValue = (entry.source.value as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let source: OpenClawChatCommandChoice.Source = switch sourceValue {
        case "native":
            .command
        case "skill":
            .skill
        case "plugin":
            .plugin
        default:
            .unknown
        }
        let aliases = (entry.textaliases ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let id = [
            source.rawValue,
            entry.name.trimmingCharacters(in: .whitespacesAndNewlines),
            aliases.first ?? "",
        ].joined(separator: ":")
        return OpenClawChatCommandChoice(
            id: id,
            name: entry.name,
            textAliases: aliases,
            description: entry.description,
            source: source,
            acceptsArgs: entry.acceptsargs)
    }

    private struct MetadataChangedPayload: Decodable {
        let modelSelectionChanged: Bool?
    }

    public static func event(from frame: EventFrame) -> OpenClawChatTransportEvent? {
        func decode<T: Decodable>(_ type: T.Type) -> T? {
            frame.payload.flatMap { try? GatewayPayloadDecoding.decode($0, as: type) }
        }

        switch frame.event {
        case "tick":
            return .tick
        case "chat.metadata.changed":
            let payload = decode(MetadataChangedPayload.self)
            return payload?.modelSelectionChanged == true ? .modelSelectionChanged : .chatMetadataChanged
        case "config.changed":
            return .modelSelectionChanged
        case "sessions.changed":
            return decode(OpenClawChatSessionsChangedEvent.self).map(OpenClawChatTransportEvent.sessionsChanged)
        case "session.reaction":
            guard let event = decode(SessionReactionEvent.self),
                  let reaction = try? self.reactionEvent(event) else { return nil }
            return .sessionReaction(reaction)
        case "session.narration":
            // Native foreground subscriptions use full streams; bounded narration
            // tails cannot replace transcript messages.
            return nil
        case "session.observer":
            return decode(SessionObserverDigest.self).map(OpenClawChatTransportEvent.sessionObserver)
        case "seqGap":
            return .seqGap
        case "health":
            guard let payload = frame.payload else { return nil }
            let ok = (try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawGatewayHealthOK.self))?.ok ?? true
            return .health(ok: ok)
        case "chat":
            return decode(OpenClawChatEventPayload.self).map(OpenClawChatTransportEvent.chat)
        case "session.message":
            guard let message = decode(OpenClawSessionMessageEventPayload.self)
            else { return nil }
            if var canonicalMessage = message.message,
               canonicalMessage.transcriptMessageID?
                   .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false,
                   let messageID = message.messageId?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !messageID.isEmpty
            {
                // Live events carry durable transcript identity on their envelope.
                // Preserve it on the row so history cannot replay the same message.
                canonicalMessage.transcriptMessageID = messageID
                return .sessionMessage(OpenClawSessionMessageEventPayload(
                    sessionKey: message.sessionKey,
                    agentId: message.agentId,
                    message: canonicalMessage,
                    messageId: message.messageId,
                    messageSeq: message.messageSeq,
                    hasActiveRun: message.hasActiveRun,
                    activeRunIds: message.activeRunIds,
                    activeRunIdsPresent: message.activeRunIdsPresent))
            }
            return .sessionMessage(message)
        case "agent":
            return decode(OpenClawAgentEventPayload.self).map(OpenClawChatTransportEvent.agent)
        case "progressCard.changed":
            return decode(ProgressCardChangedEvent.self).map(OpenClawChatTransportEvent.progressCardChanged)
        case "question.requested":
            return decode(QuestionRecord.self).map(OpenClawChatTransportEvent.questionRequested)
        case "question.resolved":
            return decode(OpenClawQuestionResolvedEvent.self).map(OpenClawChatTransportEvent.questionResolved)
        default:
            return nil
        }
    }
}
