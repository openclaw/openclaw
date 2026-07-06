import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

struct IOSGatewayChatTransport: OpenClawChatTransport {
    static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "ios.chat.transport")
    static let defaultChatSendTimeoutMs = 30000
    static let compactionRequestTimeoutSeconds = 0
    private let gateway: GatewayNodeSession
    private let globalAgentId: String?

    private struct CreateSessionParams: Codable {
        var key: String
        var agentId: String?
        var label: String?
        var parentSessionKey: String?
        var worktree: Bool?
    }

    private struct RunParams: Codable {
        var sessionKey: String
        var agentId: String?
        var runId: String
    }

    private struct ListSessionsParams: Codable {
        var includeGlobal: Bool
        var includeUnknown: Bool
        var limit: Int?
    }

    private struct SessionKeyParams: Codable {
        var key: String
        var agentId: String?
    }

    private struct ChatSendParams: Codable {
        var sessionKey: String
        var agentId: String?
        var message: String
        var thinking: String
        var attachments: [OpenClawChatAttachmentPayload]?
        var timeoutMs: Int
        var idempotencyKey: String
    }

    private struct CommandsListRequestParams: Codable {
        var scope: String
        var includeArgs: Bool
        var agentId: String?
    }

    private struct AgentWaitParams: Codable {
        var runId: String
        var timeoutMs: Int
    }

    private struct AgentWaitResponse: Codable {
        var runId: String?
        var status: String?
        var error: String?
    }

    struct AgentWaitCompletion: Equatable {
        var runId: String
        var status: String
        var completed: Bool
    }

    static func isAgentWaitCompletionStatus(_ status: String) -> Bool {
        switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "ok", "completed", "success", "succeeded":
            true
        default:
            false
        }
    }

    init(gateway: GatewayNodeSession, globalAgentId: String? = nil) {
        self.gateway = gateway
        let normalized = globalAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.globalAgentId = normalized?.isEmpty == false ? normalized : nil
    }

    static func agentWaitRequestTimeoutSeconds(timeoutMs: Int) -> Int {
        max(1, Int(ceil(Double(timeoutMs) / 1000.0)) + 5)
    }

    static func makeListSessionsParamsJSON(limit: Int?) throws -> String {
        try self.encodeParams(ListSessionsParams(includeGlobal: true, includeUnknown: false, limit: limit))
    }

    static func makeChatSendParamsJSON(
        sessionKey: String,
        agentId: String? = nil,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) throws -> String
    {
        let params = ChatSendParams(
            sessionKey: sessionKey,
            agentId: agentId,
            message: message,
            thinking: thinking,
            attachments: attachments.isEmpty ? nil : attachments,
            timeoutMs: self.defaultChatSendTimeoutMs,
            idempotencyKey: idempotencyKey)
        return try self.encodeParams(params)
    }

    static func makeCommandsListParamsJSON(
        sessionKey: String? = nil,
        agentId: String? = nil) throws -> String
    {
        try self.encodeParams(CommandsListRequestParams(
            scope: "text",
            includeArgs: true,
            agentId: self.agentID(fromSessionKey: sessionKey) ?? agentId))
    }

    static func agentID(fromSessionKey sessionKey: String?) -> String? {
        let parts = (sessionKey ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }

    static func decodeAgentWaitCompletion(_ data: Data, fallbackRunId: String) throws -> AgentWaitCompletion {
        let decoded = try JSONDecoder().decode(AgentWaitResponse.self, from: data)
        let status = (decoded.status ?? "unknown").lowercased()
        return AgentWaitCompletion(
            runId: decoded.runId ?? fallbackRunId,
            status: status,
            completed: self.isAgentWaitCompletionStatus(status))
    }

    static func makeCreateSessionParamsJSON(
        key: String,
        agentId: String? = nil,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) throws -> String
    {
        let params = CreateSessionParams(
            key: key,
            agentId: agentId,
            label: label,
            parentSessionKey: parentSessionKey,
            worktree: worktree)
        return try self.encodeParams(params)
    }

    private static func makeRunParamsJSON(
        sessionKey: String,
        agentId: String?,
        runId: String) throws -> String
    {
        try self.encodeParams(RunParams(sessionKey: sessionKey, agentId: agentId, runId: runId))
    }

    private static func makeSessionKeyParamsJSON(_ sessionKey: String, agentId: String?) throws -> String {
        try self.encodeParams(SessionKeyParams(key: sessionKey, agentId: agentId))
    }

    private static func makeHistoryParamsJSON(sessionKey: String, agentId: String?) throws -> String {
        struct Params: Codable {
            var sessionKey: String
            var agentId: String?
        }
        return try self.encodeParams(Params(sessionKey: sessionKey, agentId: agentId))
    }

    private static func makeAgentWaitParamsJSON(runId: String, timeoutMs: Int) throws -> String {
        try self.encodeParams(AgentWaitParams(runId: runId, timeoutMs: timeoutMs))
    }

    private static func encodeParams(_ params: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(params)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw EncodingError.invalidValue(
                params,
                EncodingError.Context(codingPath: [], debugDescription: "Encoded gateway params were not UTF-8"))
        }
        return json
    }

    private func selectedGlobalAgentId(for sessionKey: String) -> String? {
        sessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "global"
            ? self.globalAgentId
            : nil
    }

    func createSession(
        key: String,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        let json = try Self.makeCreateSessionParamsJSON(
            key: key,
            agentId: Self.agentID(fromSessionKey: key) ??
                parentSessionKey.flatMap { self.selectedGlobalAgentId(for: $0) },
            label: label,
            parentSessionKey: parentSessionKey,
            worktree: worktree)
        let res = try await self.gateway.request(method: "sessions.create", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: res)
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        let json = try Self.makeRunParamsJSON(
            sessionKey: sessionKey,
            agentId: self.selectedGlobalAgentId(for: sessionKey),
            runId: runId)
        _ = try await self.gateway.request(method: "chat.abort", paramsJSON: json, timeoutSeconds: 10)
    }

    func listSessions(limit: Int?) async throws -> OpenClawChatSessionsListResponse {
        let json = try Self.makeListSessionsParamsJSON(limit: limit)
        let res = try await self.gateway.request(method: "sessions.list", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: res)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        struct Params: Codable {
            var key: String
            var agentId: String?
        }
        let data = try JSONEncoder().encode(Params(
            key: sessionKey,
            agentId: self.selectedGlobalAgentId(for: sessionKey)))
        let json = String(data: data, encoding: .utf8)
        _ = try await self.gateway.request(
            method: "sessions.messages.subscribe",
            paramsJSON: json,
            timeoutSeconds: 10)
    }

    func resetSession(sessionKey: String) async throws {
        let json = try Self.makeSessionKeyParamsJSON(
            sessionKey,
            agentId: self.selectedGlobalAgentId(for: sessionKey))
        _ = try await self.gateway.request(method: "sessions.reset", paramsJSON: json, timeoutSeconds: 10)
    }

    func compactSession(sessionKey: String) async throws {
        let json = try Self.makeSessionKeyParamsJSON(
            sessionKey,
            agentId: self.selectedGlobalAgentId(for: sessionKey))
        let response = try await self.gateway.request(
            method: "sessions.compact",
            paramsJSON: json,
            timeoutSeconds: Self.compactionRequestTimeoutSeconds)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.requestHistory(sessionKey: sessionKey, ifCurrentRoute: nil)
    }

    func requestHistory(
        sessionKey: String,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> OpenClawChatHistoryPayload
    {
        let json = try Self.makeHistoryParamsJSON(
            sessionKey: sessionKey,
            agentId: self.selectedGlobalAgentId(for: sessionKey))
        let res = try await self.gateway.request(
            method: "chat.history",
            paramsJSON: json,
            timeoutSeconds: 15,
            ifCurrentRoute: expectedRoute)
        return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: res)
    }

    var supportsSlashCommandCatalog: Bool {
        true
    }

    func listCommands(sessionKey: String) async throws -> [OpenClawChatCommandChoice] {
        let json = try Self.makeCommandsListParamsJSON(
            sessionKey: sessionKey,
            agentId: self.selectedGlobalAgentId(for: sessionKey))
        let res = try await self.gateway.request(method: "commands.list", paramsJSON: json, timeoutSeconds: 15)
        let decoded = try JSONDecoder().decode(CommandsListResult.self, from: res)
        return decoded.commands.map(Self.mapCommandChoice)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.sendMessage(
            sessionKey: sessionKey,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: nil)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload],
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> OpenClawChatSendResponse
    {
        let startLogMessage =
            "chat.send start sessionKey=\(sessionKey) "
                + "len=\(message.count) attachments=\(attachments.count)"
        Self.logger.info(
            "\(startLogMessage, privacy: .public)")
        GatewayDiagnostics.log(startLogMessage)
        let json = try Self.makeChatSendParamsJSON(
            sessionKey: sessionKey,
            agentId: self.selectedGlobalAgentId(for: sessionKey),
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
        do {
            let res = try await self.gateway.request(
                method: "chat.send",
                paramsJSON: json,
                timeoutSeconds: 35,
                ifCurrentRoute: expectedRoute)
            let decoded = try JSONDecoder().decode(OpenClawChatSendResponse.self, from: res)
            Self.logger.info("chat.send ok runId=\(decoded.runId, privacy: .public)")
            GatewayDiagnostics.log("chat.send ok runId=\(decoded.runId) status=\(decoded.status)")
            return decoded
        } catch {
            Self.logger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("chat.send failed error=\(error.localizedDescription)")
            throw error
        }
    }

    private static func mapCommandChoice(_ entry: CommandEntry) -> OpenClawChatCommandChoice {
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

    func waitForRunCompletion(runId rawRunId: String, timeoutMs: Int) async -> Bool {
        await self.waitForRunCompletion(
            runId: rawRunId,
            timeoutMs: timeoutMs,
            ifCurrentRoute: nil)
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async -> Bool
    {
        let runId = rawRunId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !runId.isEmpty else { return false }

        do {
            let json = try Self.makeAgentWaitParamsJSON(runId: runId, timeoutMs: timeoutMs)
            let requestTimeoutSeconds = Self.agentWaitRequestTimeoutSeconds(timeoutMs: timeoutMs)
            GatewayDiagnostics.log("agent.wait start runId=\(runId)")
            let res = try await self.gateway.request(
                method: "agent.wait",
                paramsJSON: json,
                timeoutSeconds: requestTimeoutSeconds,
                ifCurrentRoute: expectedRoute)
            let completion = try Self.decodeAgentWaitCompletion(res, fallbackRunId: runId)
            GatewayDiagnostics.log("agent.wait completed runId=\(completion.runId) status=\(completion.status)")
            if !completion.completed {
                Self.logger.warning(
                    "agent.wait status \(completion.status, privacy: .public) runId=\(runId, privacy: .public)")
            }
            return completion.completed
        } catch {
            Self.logger.warning("agent.wait failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("agent.wait failed runId=\(runId) error=\(error.localizedDescription)")
            return false
        }
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        let seconds = max(1, Int(ceil(Double(timeoutMs) / 1000.0)))
        let res = try await self.gateway.request(method: "health", paramsJSON: nil, timeoutSeconds: seconds)
        return (try? JSONDecoder().decode(OpenClawGatewayHealthOK.self, from: res))?.ok ?? true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                let stream = await self.gateway.subscribeServerEvents()
                for await evt in stream {
                    if Task.isCancelled { return }
                    if let mapped = Self.mapEventFrame(evt) {
                        continuation.yield(mapped)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    static func mapEventFrame(_ evt: EventFrame) -> OpenClawChatTransportEvent? {
        switch evt.event {
        case "tick":
            return .tick
        case "seqGap":
            return .seqGap
        case "health":
            guard let payload = evt.payload else { return nil }
            let ok = (try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawGatewayHealthOK.self))?.ok ?? true
            return .health(ok: ok)
        case "chat":
            guard let payload = evt.payload else { return nil }
            guard let chatPayload = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawChatEventPayload.self)
            else {
                return nil
            }
            return .chat(chatPayload)
        case "session.message":
            guard let payload = evt.payload else { return nil }
            guard let message = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawSessionMessageEventPayload.self)
            else {
                return nil
            }
            return .sessionMessage(message)
        case "agent":
            guard let payload = evt.payload else { return nil }
            guard let agentPayload = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawAgentEventPayload.self)
            else {
                return nil
            }
            return .agent(agentPayload)
        default:
            return nil
        }
    }
}
