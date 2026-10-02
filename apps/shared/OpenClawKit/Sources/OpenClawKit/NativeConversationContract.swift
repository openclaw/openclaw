import Foundation

/// Frozen conversation surface contract; its wire version remains 1 while unreleased.
public enum NativeConversationContract {
    public static let handlerName = "openclawConversation"
    public static let hostScript = """
    window.__OPENCLAW_NATIVE_EMBED__ = { platform: "macos", formFactor: "desktop", surface: "conversation" };
    window.__OPENCLAW_NATIVE_CONVERSATION__ = { contract: 1 };
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

public struct NativeConversationContext: Codable, Equatable, Sendable {
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
    }

    private enum Kind: String, Codable {
        case navigate, presentation
        case focusComposer = "focus-composer"
    }

    private struct Empty: Codable {
        init() {}

        init(from decoder: any Decoder) throws {
            let fields = try [String: String](from: decoder)
            guard fields.isEmpty else {
                throw DecodingError.dataCorrupted(.init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Expected empty payload"))
            }
        }

        func encode(to encoder: any Encoder) throws {
            try [String: String]().encode(to: encoder)
        }
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
            _ = try container.decode(Empty.self, forKey: .payload)
            self.action = .focusComposer
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: NativeConversationContract.Keys.self)
        try container.encode(1, forKey: .contract)
        try container.encode(self.documentId, forKey: .documentId)
        try container.encode(self.requestId, forKey: .requestId)
        let kind: Kind
        switch self.action {
        case let .navigate(payload):
            kind = .navigate
            try container.encode(payload, forKey: .payload)
        case let .presentation(payload):
            kind = .presentation
            try container.encode(payload, forKey: .payload)
        case .focusComposer:
            kind = .focusComposer
            try container.encode(Empty(), forKey: .payload)
        }
        try container.encode(kind, forKey: .type)
    }

    public func javaScript() throws -> String {
        guard let json = try String(bytes: JSONEncoder().encode(self), encoding: .utf8) else {
            throw EncodingError.invalidValue(self, .init(codingPath: [], debugDescription: "Invalid UTF-8 JSON"))
        }
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
    }

    private enum Kind: String, Codable {
        case ready, state
        case commandResult = "command-result"
        case routeChanged = "route-changed"
        case openDashboard = "open-dashboard"
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
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: NativeConversationContract.Keys.self)
        try container.encode(1, forKey: .contract)
        try container.encode(self.documentId, forKey: .documentId)
        let kind: Kind
        switch self.body {
        case let .ready(payload):
            kind = .ready
            try payload.encode(to: encoder)
        case let .state(payload):
            kind = .state
            try payload.encode(to: encoder)
        case let .commandResult(payload):
            kind = .commandResult
            try payload.encode(to: encoder)
        case let .routeChanged(payload):
            kind = .routeChanged
            try payload.encode(to: encoder)
        case let .openDashboard(payload):
            kind = .openDashboard
            try payload.encode(to: encoder)
        }
        try container.encode(kind, forKey: .type)
    }
}
