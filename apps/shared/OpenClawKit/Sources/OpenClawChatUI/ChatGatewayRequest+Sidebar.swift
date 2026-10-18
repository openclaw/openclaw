import Foundation
import OpenClawProtocol

public enum OpenClawChatSidebarStatus: String, Sendable { case active, snoozed, archived, all }
public enum OpenClawChatSidebarAgentScope: Equatable, Sendable { case selected, all }

public struct OpenClawChatSidebarQuery: Equatable, Sendable {
    public var agentID: String?
    public var status: OpenClawChatSidebarStatus
    public var search: String
    public var ownerId: String?
    public var involvingMe: Bool?
    public var excludeCron: Bool
    public var excludeSystem: Bool

    public init(
        agentID: String?,
        status: OpenClawChatSidebarStatus = .active,
        search: String = "",
        ownerId: String? = nil,
        involvingMe: Bool? = nil,
        excludeCron: Bool = true,
        excludeSystem: Bool = true)
    {
        self.agentID = ChatPayloadDecoding.trimmedNonEmptyString(agentID)
        self.status = status
        self.search = search.trimmingCharacters(in: .whitespacesAndNewlines)
        self.ownerId = ChatPayloadDecoding.trimmedNonEmptyString(ownerId)
        self.involvingMe = involvingMe == true ? true : nil
        self.excludeCron = excludeCron
        self.excludeSystem = excludeSystem
    }

    var wire: Self {
        var query = self
        if query.status == .snoozed { query.status = .active }
        if query.search.isEmpty {
            query.excludeCron = false
            query.excludeSystem = false
        }
        if query.agentID == nil, query.search.isEmpty {
            query.status = .all
            query.ownerId = nil
        }
        if query.involvingMe == true { query.ownerId = nil }
        return query
    }
}

public protocol OpenClawChatSidebarTransport: OpenClawChatTransport {
    func acquireSidebarRequest() async throws -> @Sendable (OpenClawChatGatewayRequest) async throws -> Data
    func loadSidebarAgentAvatar(_ source: String) async -> Data?
}

extension OpenClawChatGatewayRequests {
    public static func sidebarSessions(query: OpenClawChatSidebarQuery, limit: Int, offset: Int = 0)
        -> OpenClawChatGatewayRequest
    {
        let query = query.wire
        let request = self.sessionsList(
            limit: limit,
            search: query.search,
            archived: query.status == .archived,
            agentID: query.agentID,
            includeUnknown: true,
            offset: offset > 0 ? offset : nil,
            configuredAgentsOnly: true)
        var params = request.params
        // ui/src/components/command-palette.ts:49 excludes hidden discovery rows before the server limit.
        if query.excludeCron { params["excludeCron"] = AnyCodable(true) }
        if query.excludeSystem { params["excludeSystem"] = AnyCodable(true) }
        // ui/src/components/session-data-controller-events.ts:110 enriches browsing; palette search omits enrichment.
        if query.search.isEmpty {
            params["includeDerivedTitles"] = AnyCodable(true)
            params["includeLastMessage"] = AnyCodable(true)
        }
        if query.status == .all { params["archived"] = AnyCodable("all") }
        if query.involvingMe == true {
            params["involvingMe"] = AnyCodable(true)
        } else if let ownerId = query.ownerId {
            params["ownerId"] = AnyCodable(ownerId)
        }
        return OpenClawChatGatewayRequest(method: request.method, params: params, timeoutMs: request.timeoutMs)
    }

    public static func sidebarTranscriptSearch(query: OpenClawChatSidebarQuery) -> OpenClawChatGatewayRequest {
        let request = self.sidebarSessions(query: query, limit: 25)
        var scope = request.params
        // ui/src/lib/sessions/transcript-search.ts:22: pagination/enrichment do not restrict the search corpus.
        for key in ["limit", "offset", "includeDerivedTitles", "includeLastMessage", "ownerFirst", "search"] {
            scope.removeValue(forKey: key)
        }
        return OpenClawChatGatewayRequest(
            method: "sessions.search",
            params: [
                "query": AnyCodable(query.search), "limit": AnyCodable(25), "scope": AnyCodable(scope),
            ],
            timeoutMs: request.timeoutMs)
    }
}
