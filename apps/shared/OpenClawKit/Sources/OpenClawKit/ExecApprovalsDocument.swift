import Foundation

public enum ExecApprovalsSecurity: String, CaseIterable, Codable, Identifiable, Sendable {
    case deny
    case allowlist
    case full

    public var id: String {
        self.rawValue
    }
}

public enum ExecApprovalsAsk: String, CaseIterable, Codable, Identifiable, Sendable {
    case off
    case onMiss = "on-miss"
    case always

    public var id: String {
        self.rawValue
    }
}

public struct ExecApprovalsAllowlistEntry: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var pattern: String
    public var source: String?
    public var commandText: String?
    public var argPattern: String?
    public var lastUsedAt: Double?
    public var lastUsedCommand: String?
    public var lastResolvedPath: String?

    public init(
        id: String = UUID().uuidString,
        pattern: String,
        source: String? = nil,
        commandText: String? = nil,
        argPattern: String? = nil,
        lastUsedAt: Double? = nil,
        lastUsedCommand: String? = nil,
        lastResolvedPath: String? = nil)
    {
        self.id = id
        self.pattern = pattern
        self.source = source
        self.commandText = commandText
        self.argPattern = argPattern
        self.lastUsedAt = lastUsedAt
        self.lastUsedCommand = lastUsedCommand
        self.lastResolvedPath = lastResolvedPath
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case pattern
        case source
        case commandText
        case argPattern
        case lastUsedAt
        case lastUsedCommand
        case lastResolvedPath
    }

    public init(from decoder: Decoder) throws {
        if let container = try? decoder.singleValueContainer(),
           let legacyPattern = try? container.decode(String.self)
        {
            self.init(pattern: legacyPattern.trimmingCharacters(in: .whitespacesAndNewlines))
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedID = try container.decodeIfPresent(String.self, forKey: .id)
        let id = decodedID.flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
        try self.init(
            id: id,
            pattern: container.decode(String.self, forKey: .pattern),
            source: container.decodeIfPresent(String.self, forKey: .source),
            commandText: container.decodeIfPresent(String.self, forKey: .commandText),
            argPattern: container.decodeIfPresent(String.self, forKey: .argPattern),
            lastUsedAt: container.decodeIfPresent(Double.self, forKey: .lastUsedAt),
            lastUsedCommand: container.decodeIfPresent(String.self, forKey: .lastUsedCommand),
            lastResolvedPath: container.decodeIfPresent(String.self, forKey: .lastResolvedPath))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.id, forKey: .id)
        try container.encode(self.pattern, forKey: .pattern)
        try container.encodeIfPresent(self.source, forKey: .source)
        try container.encodeIfPresent(self.argPattern, forKey: .argPattern)
        try container.encodeIfPresent(self.lastUsedAt, forKey: .lastUsedAt)
        try container.encodeIfPresent(self.lastUsedCommand, forKey: .lastUsedCommand)
        try container.encodeIfPresent(self.lastResolvedPath, forKey: .lastResolvedPath)
    }
}

public struct ExecApprovalsDefaultsDocument: Codable, Sendable, Equatable {
    public var security: ExecApprovalsSecurity?
    public var ask: ExecApprovalsAsk?
    public var askFallback: ExecApprovalsSecurity?
    public var autoAllowSkills: Bool?

    public init(
        security: ExecApprovalsSecurity? = nil,
        ask: ExecApprovalsAsk? = nil,
        askFallback: ExecApprovalsSecurity? = nil,
        autoAllowSkills: Bool? = nil)
    {
        self.security = security
        self.ask = ask
        self.askFallback = askFallback
        self.autoAllowSkills = autoAllowSkills
    }
}

public struct ExecApprovalsMcpToolGrant: Codable, Sendable, Equatable {
    public var server: String
    public var tool: String
    public var source: String
    public var addedAt: Double
    public var lastUsedAt: Double?

    public init(server: String, tool: String, source: String, addedAt: Double, lastUsedAt: Double? = nil) {
        self.server = server
        self.tool = tool
        self.source = source
        self.addedAt = addedAt
        self.lastUsedAt = lastUsedAt
    }
}

public struct ExecApprovalsAgentDocument: Codable, Sendable, Equatable {
    public var security: ExecApprovalsSecurity?
    public var ask: ExecApprovalsAsk?
    public var askFallback: ExecApprovalsSecurity?
    public var autoAllowSkills: Bool?
    public var allowlist: [ExecApprovalsAllowlistEntry]?
    public var mcpTools: [ExecApprovalsMcpToolGrant]?

    public init(
        security: ExecApprovalsSecurity? = nil,
        ask: ExecApprovalsAsk? = nil,
        askFallback: ExecApprovalsSecurity? = nil,
        autoAllowSkills: Bool? = nil,
        allowlist: [ExecApprovalsAllowlistEntry]? = nil,
        mcpTools: [ExecApprovalsMcpToolGrant]? = nil)
    {
        self.security = security
        self.ask = ask
        self.askFallback = askFallback
        self.autoAllowSkills = autoAllowSkills
        self.allowlist = allowlist
        self.mcpTools = mcpTools
    }

    public var isEmpty: Bool {
        self.security == nil && self.ask == nil && self.askFallback == nil
            && self.autoAllowSkills == nil && (self.allowlist?.isEmpty ?? true)
            && (self.mcpTools?.isEmpty ?? true)
    }
}

public struct ExecApprovalsSocketDocument: Codable, Sendable, Equatable {
    public var path: String?
    public var token: String?

    public init(path: String? = nil, token: String? = nil) {
        self.path = path
        self.token = token
    }
}

public struct ExecApprovalsDocument: Codable, Sendable, Equatable {
    public var version: Int
    public var socket: ExecApprovalsSocketDocument?
    public var defaults: ExecApprovalsDefaultsDocument?
    public var agents: [String: ExecApprovalsAgentDocument]?

    public init(
        version: Int,
        socket: ExecApprovalsSocketDocument? = nil,
        defaults: ExecApprovalsDefaultsDocument? = nil,
        agents: [String: ExecApprovalsAgentDocument]? = nil)
    {
        self.version = version
        self.socket = socket
        self.defaults = defaults
        self.agents = agents
    }
}
