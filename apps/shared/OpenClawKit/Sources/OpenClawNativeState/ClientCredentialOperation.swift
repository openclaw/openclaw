import Foundation

/// The bounded local credential protocol. Wire row keys match the TypeScript owner.
public struct ClientCredentialOperation: Codable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case identityRead = "identity.read"
        case identityCreate = "identity.create"
        case identityRepair = "identity.repair"
        case tokenRead = "token.read"
        case tokenList = "token.list"
        case tokenReplace = "token.replace"
        case tokenRemove = "token.remove"
        case socketRead = "socket.read", socketEnsure = "socket.ensure"
        case nativeTokensClear = "native.tokens.clear", nativeTokenClaim = "native.token.claim"
    }

    public struct TokenKey: Codable, Sendable {
        public var device_id: String
        public var role: String
        public var gateway_scope: String?

        public init(deviceID: String, role: String, gatewayScope: String? = nil) {
            self.device_id = deviceID
            self.role = role
            self.gateway_scope = gatewayScope
        }
    }

    public struct Selector: Codable, Sendable {
        public enum Kind: String, Codable, Sendable { case all, role, gateway, unscoped }
        public var kind: Kind
        public var role: String?
        public var gateway: String?
        public init(kind: Kind, role: String? = nil, gateway: String? = nil) {
            self.kind = kind
            self.role = role
            self.gateway = gateway
        }
    }

    public struct RequestedSocket: Codable, Sendable {
        public var path: String?
        public var token: String?
    }

    public let kind: Kind
    public var identity_key: String?
    public var identity: OpenClawClientCredentialStore.Identity?
    public var key: TokenKey?
    public var token: OpenClawClientCredentialStore.Token?
    public var fallback: OpenClawClientCredentialStore.SocketCredentials?
    public var requested: RequestedSocket?
    public var expectedToken: String?
    public var observedToken: String?
    public var hasExpectedToken = false
    public var device_id: String?
    public var role: String?
    public var gateway: String?
    public var selector: Selector?
    public var gateway_scope: String?
    public var afterRole: String?
    public var limit: Int?

    public init(kind: Kind) {
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey {
        case kind, identity_key, identity, key, token, fallback, requested, expectedToken, observedToken, device_id,
             role, gateway,
             selector
        case afterRole, limit, gateway_scope
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.kind = try values.decode(Kind.self, forKey: .kind)
        self.identity_key = try values.decodeIfPresent(String.self, forKey: .identity_key)
        self.identity = try values.decodeIfPresent(OpenClawClientCredentialStore.Identity.self, forKey: .identity)
        self.key = try values.decodeIfPresent(TokenKey.self, forKey: .key)
        self.token = try values.decodeIfPresent(OpenClawClientCredentialStore.Token.self, forKey: .token)
        self.fallback = try values.decodeIfPresent(
            OpenClawClientCredentialStore.SocketCredentials.self,
            forKey: .fallback)
        self.requested = try values.decodeIfPresent(RequestedSocket.self, forKey: .requested)
        self.hasExpectedToken = values.contains(.expectedToken)
        self.expectedToken = try values.decodeIfPresent(String.self, forKey: .expectedToken)
        self.observedToken = try values.decodeIfPresent(String.self, forKey: .observedToken)
        self.device_id = try values.decodeIfPresent(String.self, forKey: .device_id)
        self.role = try values.decodeIfPresent(String.self, forKey: .role)
        self.gateway = try values.decodeIfPresent(String.self, forKey: .gateway)
        self.selector = try values.decodeIfPresent(Selector.self, forKey: .selector)
        self.gateway_scope = try values.decodeIfPresent(String.self, forKey: .gateway_scope)
        self.afterRole = try values.decodeIfPresent(String.self, forKey: .afterRole)
        self.limit = try values.decodeIfPresent(Int.self, forKey: .limit)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(self.kind, forKey: .kind)
        try values.encodeIfPresent(self.identity_key, forKey: .identity_key)
        try values.encodeIfPresent(self.identity, forKey: .identity)
        try values.encodeIfPresent(self.key, forKey: .key)
        try values.encodeIfPresent(self.token, forKey: .token)
        try values.encodeIfPresent(self.fallback, forKey: .fallback)
        try values.encodeIfPresent(self.requested, forKey: .requested)
        if self.hasExpectedToken {
            try values.encode(self.expectedToken, forKey: .expectedToken)
        }
        try values.encodeIfPresent(self.observedToken, forKey: .observedToken)
        try values.encodeIfPresent(self.device_id, forKey: .device_id)
        try values.encodeIfPresent(self.role, forKey: .role)
        try values.encodeIfPresent(self.gateway, forKey: .gateway)
        try values.encodeIfPresent(self.selector, forKey: .selector)
        try values.encodeIfPresent(self.gateway_scope, forKey: .gateway_scope)
        try values.encodeIfPresent(self.afterRole, forKey: .afterRole)
        try values.encodeIfPresent(self.limit, forKey: .limit)
    }
}

public struct ClientCredentialResult: Codable, Sendable {
    public enum Kind: String, Codable,
    Sendable { case identity, token, tokens, socket, changed, cleared, identityRepair }
    public let kind: Kind
    public var identity: OpenClawClientCredentialStore.Identity?
    public var token: OpenClawClientCredentialStore.Token?
    public var tokens: [OpenClawClientCredentialStore.Token]?
    public var socket: OpenClawClientCredentialStore.SocketCredentials?
    public var changed: Bool?
    public var count: Int?
    public var repaired: Bool?
    public var rotated: Bool?
    public var nextRole: String?
    public init(kind: Kind) {
        self.kind = kind
    }
}

extension ClientCredentialResult {
    private enum ResultKeys: String,
    CodingKey { case kind, identity, token, tokens, socket, changed, count, nextRole, repaired, rotated }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: ResultKeys.self)
        try values.encode(self.kind, forKey: .kind)
        switch self.kind {
        case .identity: try values.encode(self.identity, forKey: .identity)
        case .token: try values.encode(self.token, forKey: .token)
        case .socket: try values.encode(self.socket, forKey: .socket)
        case .tokens:
            try values.encode(self.tokens ?? [], forKey: .tokens)
            try values.encode(self.nextRole, forKey: .nextRole)
        case .changed: try values.encode(self.changed ?? false, forKey: .changed)
        case .cleared: try values.encode(self.count ?? 0, forKey: .count)
        case .identityRepair:
            try values.encode(self.identity, forKey: .identity)
            try values.encode(self.repaired ?? false, forKey: .repaired)
            try values.encode(self.rotated ?? false, forKey: .rotated)
        }
    }
}

extension OpenClawClientCredentialStore.SocketCredentials {
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode("current", forKey: .socketKey)
        try values.encode(path, forKey: .path)
        try values.encode(token, forKey: .token)
        try values.encode(updatedAtMs, forKey: .updatedAtMs)
    }
}
