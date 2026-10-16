import Foundation

/// Frozen conversation surface contract; its wire version remains 1 while unreleased.
public enum NativeConversationContract {
    public static let handlerName = "openclawConversation"
    public static let hostScript = """
    window.__OPENCLAW_NATIVE_EMBED__ = { platform: "macos", formFactor: "desktop", surface: "conversation" };
    window.__OPENCLAW_NATIVE_CONVERSATION__ = {
      contract: 1, features: ["session-facts-v1", "session-actions-v1"]
    };
    """
    public static let documentProbe = "window.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__?.documentId"

    fileprivate enum Keys: String, CodingKey {
        case contract, documentId, requestId, type, payload
    }

    fileprivate static func decodeDocument(_ decoder: any Decoder) throws -> String {
        let container = try decoder.container(keyedBy: Keys.self)
        guard try container.decode(Int.self, forKey: .contract) == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .contract, in: container, debugDescription: "unsupported")
        }
        let document = try container.decode(String.self, forKey: .documentId)
        guard !document.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .documentId,
                in: container,
                debugDescription: "invalid-document")
        }
        return document
    }
}

public struct NativeConversationContext: Codable, Hashable, Sendable {
    public let agentId: String
    public let sessionKey: String

    public init(agentId: String, sessionKey: String) {
        self.agentId = agentId
        self.sessionKey = sessionKey
    }
}

public struct NativeConversationPresentation: Codable, Equatable, Sendable {
    public let visible: Bool
    public let active: Bool

    public init(visible: Bool, active: Bool) {
        self.visible = visible
        self.active = active
    }
}

public struct NativeConversationCommand: Codable, Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case navigate(NativeConversationContext)
        case presentation(NativeConversationPresentation)
        case focusComposer
        case openSessionActions(NativeConversationContext)
    }

    private enum Kind: String, Codable {
        case navigate, presentation
        case focusComposer = "focus-composer"
        case openSessionActions = "open-session-actions"
    }

    public let documentId: String
    public let requestId: String
    public let action: Action

    public init(documentId: String, requestId: String, action: Action) {
        self.documentId = documentId
        self.requestId = requestId
        self.action = action
    }

    public init(from decoder: any Decoder) throws {
        self.documentId = try NativeConversationContract.decodeDocument(decoder)
        let container = try decoder.container(keyedBy: NativeConversationContract.Keys.self)
        self.requestId = try container.decode(String.self, forKey: .requestId)
        switch try container.decode(Kind.self, forKey: .type) {
        case .navigate: self.action = try .navigate(container.decode(NativeConversationContext.self, forKey: .payload))
        case .presentation:
            self.action = try .presentation(container.decode(NativeConversationPresentation.self, forKey: .payload))
        case .focusComposer:
            guard try container.decode([String: String].self, forKey: .payload).isEmpty else {
                throw DecodingError.dataCorruptedError(
                    forKey: .payload, in: container, debugDescription: "Expected empty payload")
            }
            self.action = .focusComposer
        case .openSessionActions:
            self.action = try .openSessionActions(container.decode(NativeConversationContext.self, forKey: .payload))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: NativeConversationContract.Keys.self)
        try container.encode(1, forKey: .contract)
        try container.encode(self.documentId, forKey: .documentId)
        try container.encode(self.requestId, forKey: .requestId)
        let (kind, payload): (Kind, any Encodable) = switch self.action {
        case let .navigate(payload): (.navigate, payload)
        case let .presentation(payload): (.presentation, payload)
        case .focusComposer: (.focusComposer, [String: String]())
        case let .openSessionActions(payload): (.openSessionActions, payload)
        }
        try container.encode(payload, forKey: .payload)
        try container.encode(kind, forKey: .type)
    }

    public func javaScript() throws -> String {
        let json = try String(bytes: JSONEncoder().encode(self), encoding: .utf8)!
        // A replacement can commit after native queues evaluation.
        return """
        (() => {
          const command = \(json);
          if (window.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__?.documentId !== command.documentId) return false;
          window.dispatchEvent(new CustomEvent("openclaw:native-conversation-command", { detail: command }));
          return true;
        })()
        """
    }
}

public struct NativeConversationReady: Codable, Equatable, Sendable {
    public enum Surface: String, Codable, Sendable { case conversation }
    public let surface: Surface
    public let capabilities: [String]
}

public struct NativeConversationState: Codable, Equatable, Sendable {
    public enum Connection: String, Codable, Sendable {
        case connected, connecting, offline
        case signedOut = "signed-out"
    }

    public struct Run: Codable, Equatable, Sendable { public let active: Bool }
    public let revision: UInt64
    public let context: NativeConversationContext
    public let title: String
    public let run: Run
    public let connection: Connection
}

/// A complete, bounded projection of the current web sidebar's composer badges.
public struct NativeConversationSessionFacts: Codable, Equatable, Sendable {
    public static let maximumBytes = 65536
    public struct Session: Codable, Equatable, Sendable {
        public let agentId: String
        public let sessionKey: String
        public let hasComposerDraft: Bool
        public let outboxAttentionCount: UInt64

        public var context: NativeConversationContext {
            .init(agentId: self.agentId, sessionKey: self.sessionKey)
        }
    }

    public let revision: UInt64
    /// Nil means unavailable; an empty array is a known empty projection.
    public let sessions: [Session]?
    private enum CodingKeys: String, CodingKey { case revision, sessions }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.revision = try container.decode(UInt64.self, forKey: .revision)
        self.sessions = try container.decode([Session]?.self, forKey: .sessions)
        let rows = self.sessions ?? []
        guard (1...9_007_199_254_740_991).contains(self.revision), rows.count <= 64,
              Set(rows.map(\.context)).count == rows.count,
              rows.allSatisfy({ row in
                  !row.agentId.isEmpty && row.agentId.utf8.count <= 4096 &&
                      !row.sessionKey.isEmpty && row.sessionKey.utf8.count <= 4096 &&
                      row.outboxAttentionCount <= 9_007_199_254_740_991
              })
        else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "invalid-session-facts"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.revision, forKey: .revision)
        try container.encode(self.sessions, forKey: .sessions)
    }
}

public struct NativeConversationResult: Codable, Equatable, Sendable {
    public let requestId: String
    public let ok: Bool
    public let error: String?

    public init(requestId: String, ok: Bool, error: String? = nil) {
        self.requestId = requestId
        self.ok = ok
        self.error = error
    }
}

public struct NativeConversationRouteChanged: Codable, Equatable, Sendable {
    public enum Reason: String, Codable, Sendable { case fork, link, new, other }
    public let agentId: String
    public let sessionKey: String
    public let reason: Reason
}

public struct NativeConversationDashboardRoute: Codable, Equatable, Sendable {
    public let path: String
    public let search: String?
}

public struct NativeConversationMessage: Codable, Equatable, Sendable {
    public enum Body: Equatable, Sendable {
        case ready(NativeConversationReady)
        case state(NativeConversationState)
        case commandResult(NativeConversationResult)
        case routeChanged(NativeConversationRouteChanged)
        case openDashboard(NativeConversationDashboardRoute)
        case sessionFacts(NativeConversationSessionFacts)
    }

    private enum Kind: String, Codable {
        case ready, state
        case commandResult = "command-result"
        case routeChanged = "route-changed"
        case openDashboard = "open-dashboard"
        case sessionFacts = "session-facts"
    }

    public let documentId: String
    public let body: Body

    public init(documentId: String, body: Body) {
        self.documentId = documentId
        self.body = body
    }

    public init(from decoder: any Decoder) throws {
        self.documentId = try NativeConversationContract.decodeDocument(decoder)
        let container = try decoder.container(keyedBy: NativeConversationContract.Keys.self)
        switch try container.decode(Kind.self, forKey: .type) {
        case .ready: self.body = try .ready(NativeConversationReady(from: decoder))
        case .state: self.body = try .state(NativeConversationState(from: decoder))
        case .commandResult: self.body = try .commandResult(NativeConversationResult(from: decoder))
        case .routeChanged: self.body = try .routeChanged(NativeConversationRouteChanged(from: decoder))
        case .openDashboard: self.body = try .openDashboard(NativeConversationDashboardRoute(from: decoder))
        case .sessionFacts: self.body = try .sessionFacts(NativeConversationSessionFacts(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: NativeConversationContract.Keys.self)
        try container.encode(1, forKey: .contract)
        try container.encode(self.documentId, forKey: .documentId)
        let (kind, payload): (Kind, any Encodable) = switch self.body {
        case let .ready(payload): (.ready, payload)
        case let .state(payload): (.state, payload)
        case let .commandResult(payload): (.commandResult, payload)
        case let .routeChanged(payload): (.routeChanged, payload)
        case let .openDashboard(payload): (.openDashboard, payload)
        case let .sessionFacts(payload): (.sessionFacts, payload)
        }
        try payload.encode(to: encoder)
        try container.encode(kind, forKey: .type)
    }
}
