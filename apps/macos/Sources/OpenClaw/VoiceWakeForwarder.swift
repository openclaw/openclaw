import Foundation
import OpenClawChatUI
import OSLog

enum VoiceWakeForwarder {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.forward")

    static func prefixedTranscript(_ transcript: String, machineName: String? = nil) -> String {
        let resolvedMachine = machineName?.nonEmpty
            ?? Host.current().localizedName
            ?? ProcessInfo.processInfo.hostName

        let safeMachine = resolvedMachine.isEmpty ? "this Mac" : resolvedMachine
        return """
        User talked via voice recognition on \(safeMachine) - repeat prompt first \
        + remember some words might be incorrectly transcribed.

        \(transcript)
        """
    }

    enum VoiceWakeForwardError: LocalizedError, Equatable {
        case rpcFailed(String)

        var errorDescription: String? {
            switch self {
            case let .rpcFailed(message): message
            }
        }
    }

    private struct SessionListResponse: Decodable {
        let sessions: [SessionRouteEntry]
    }

    struct SessionRouteEntry: Decodable, Equatable {
        let key: String
        let channel: String?
        let lastChannel: String?
        let lastTo: String?
        let deliveryContext: DeliveryContext?
    }

    struct DeliveryContext: Decodable, Equatable {
        let channel: String?
        let to: String?
    }

    static func selectedSessionInvocation(
        transcript: String,
        voiceWakeTrigger: String? = nil) async -> GatewayAgentInvocation
    {
        let activeSessionKey = await MainActor.run { WebChatManager.shared.activeSessionKey }
        let sessionKey: String = if let activeSessionKey = activeSessionKey?.nonEmpty {
            activeSessionKey
        } else {
            await GatewayConnection.shared.mainSessionKey()
        }

        let routeEntries = await self.loadSessionRouteEntries()
        return self.makeInvocation(
            transcript: transcript,
            sessionKey: sessionKey,
            routeEntries: routeEntries,
            voiceWakeTrigger: voiceWakeTrigger)
    }

    static func makeInvocation(
        transcript: String,
        sessionKey: String = "main",
        routeEntries: [SessionRouteEntry] = [],
        voiceWakeTrigger: String? = nil) -> GatewayAgentInvocation
    {
        let comparisonKey = OpenClawChatSessionKey.comparisonKey(sessionKey)
        let routeEntry = routeEntries.first {
            OpenClawChatSessionKey.comparisonKey($0.key) == comparisonKey
        }
        let parsedRoute = self.parseSessionKeyRoute(sessionKey)
        let channelRaw = self.firstNonEmpty(
            routeEntry?.deliveryContext?.channel,
            routeEntry?.lastChannel,
            routeEntry?.channel,
            parsedRoute?.channel)
        let channel = channelRaw
            .flatMap { GatewayAgentChannel(rawValue: $0.lowercased()) }
            ?? .webchat
        let to = self.firstNonEmpty(
            routeEntry?.deliveryContext?.to,
            routeEntry?.lastTo,
            parsedRoute?.to)

        return GatewayAgentInvocation(
            message: self.prefixedTranscript(transcript),
            sessionKey: sessionKey,
            deliver: channel.isDeliverable,
            to: to,
            channel: channel,
            voiceWakeTrigger: voiceWakeTrigger)
    }

    @discardableResult
    static func forward(
        transcript: String) async -> Result<Void, VoiceWakeForwardError>
    {
        await self.forward(invocation: self.makeInvocation(transcript: transcript))
    }

    static func forward(invocation: GatewayAgentInvocation) async -> Result<Void, VoiceWakeForwardError> {
        let result = await GatewayConnection.shared.sendAgent(invocation)

        if result.ok {
            return .success(())
        }

        let message = result.error ?? "agent rpc unavailable"
        self.logger.error("voice wake forward failed: \(message, privacy: .public)")
        return .failure(.rpcFailed(message))
    }

    private static func loadSessionRouteEntries() async -> [SessionRouteEntry] {
        do {
            let request = OpenClawChatGatewayRequests.sessionsList(
                limit: 500,
                search: nil,
                archived: false,
                includeGlobal: false,
                timeoutMs: 10000)
            let data = try await GatewayConnection.shared.request(request)
            return try JSONDecoder().decode(SessionListResponse.self, from: data).sessions
        } catch {
            self.logger.debug(
                "voice wake selected route lookup failed: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    private static func parseSessionKeyRoute(_ sessionKey: String) -> (channel: String, to: String?)? {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let rawParts = trimmed.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
        let body: [String] = if rawParts.count >= 3, rawParts[0].caseInsensitiveCompare("agent") == .orderedSame {
            Array(rawParts.dropFirst(2))
        } else {
            rawParts
        }
        guard body.count >= 3 else { return nil }
        let kind = body[1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard kind == "direct" || kind == "group" || kind == "channel" else { return nil }
        let channel = body[0].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !channel.isEmpty else { return nil }
        let to = body.dropFirst(2)
            .joined(separator: ":")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (channel: channel, to: to.isEmpty ? nil : to)
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        values.lazy.compactMap { $0?.nonEmpty }.first
    }
}
