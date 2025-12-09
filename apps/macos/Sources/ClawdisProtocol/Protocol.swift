// This file was generated from JSON Schema using quicktype, do not modify it directly.
// To parse the JSON, add this file to your project and do:
//
//   let clawdisGateway = try ClawdisGateway(json)

import Foundation

/// Handshake, request/response, and event frames for the Gateway WebSocket.
// MARK: - ClawdisGateway
struct ClawdisGateway: Codable {
    let auth: Auth?
    let caps: [String]?
    let client: Client?
    let locale: String?
    let maxProtocol, minProtocol: Int?
    let type: TypeEnum
    let userAgent: String?
    let features: Features?
    let policy: Policy?
    let clawdisGatewayProtocol: Int?
    let server: Server?
    let snapshot: Snapshot?
    let expectedProtocol: Int?
    let minClient, reason, id, method: String?
    let params: JSONAny?
    let error: Error?
    let ok: Bool?
    let payload: JSONAny?
    let event: String?
    let seq: Int?
    let stateVersion: ClawdisGatewayStateVersion?

    enum CodingKeys: String, CodingKey {
        case auth, caps, client, locale, maxProtocol, minProtocol, type, userAgent, features, policy
        case clawdisGatewayProtocol = "protocol"
        case server, snapshot, expectedProtocol, minClient, reason, id, method, params, error, ok, payload, event, seq, stateVersion
    }
}

// MARK: ClawdisGateway convenience initializers and mutators

extension ClawdisGateway {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ClawdisGateway.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        auth: Auth?? = nil,
        caps: [String]?? = nil,
        client: Client?? = nil,
        locale: String?? = nil,
        maxProtocol: Int?? = nil,
        minProtocol: Int?? = nil,
        type: TypeEnum? = nil,
        userAgent: String?? = nil,
        features: Features?? = nil,
        policy: Policy?? = nil,
        clawdisGatewayProtocol: Int?? = nil,
        server: Server?? = nil,
        snapshot: Snapshot?? = nil,
        expectedProtocol: Int?? = nil,
        minClient: String?? = nil,
        reason: String?? = nil,
        id: String?? = nil,
        method: String?? = nil,
        params: JSONAny?? = nil,
        error: Error?? = nil,
        ok: Bool?? = nil,
        payload: JSONAny?? = nil,
        event: String?? = nil,
        seq: Int?? = nil,
        stateVersion: ClawdisGatewayStateVersion?? = nil
    ) -> ClawdisGateway {
        return ClawdisGateway(
            auth: auth ?? self.auth,
            caps: caps ?? self.caps,
            client: client ?? self.client,
            locale: locale ?? self.locale,
            maxProtocol: maxProtocol ?? self.maxProtocol,
            minProtocol: minProtocol ?? self.minProtocol,
            type: type ?? self.type,
            userAgent: userAgent ?? self.userAgent,
            features: features ?? self.features,
            policy: policy ?? self.policy,
            clawdisGatewayProtocol: clawdisGatewayProtocol ?? self.clawdisGatewayProtocol,
            server: server ?? self.server,
            snapshot: snapshot ?? self.snapshot,
            expectedProtocol: expectedProtocol ?? self.expectedProtocol,
            minClient: minClient ?? self.minClient,
            reason: reason ?? self.reason,
            id: id ?? self.id,
            method: method ?? self.method,
            params: params ?? self.params,
            error: error ?? self.error,
            ok: ok ?? self.ok,
            payload: payload ?? self.payload,
            event: event ?? self.event,
            seq: seq ?? self.seq,
            stateVersion: stateVersion ?? self.stateVersion
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Auth
struct Auth: Codable {
    let token: String?
}

// MARK: Auth convenience initializers and mutators

extension Auth {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Auth.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        token: String?? = nil
    ) -> Auth {
        return Auth(
            token: token ?? self.token
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Client
struct Client: Codable {
    let instanceID: String?
    let mode, name, platform, version: String

    enum CodingKeys: String, CodingKey {
        case instanceID = "instanceId"
        case mode, name, platform, version
    }
}

// MARK: Client convenience initializers and mutators

extension Client {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Client.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        instanceID: String?? = nil,
        mode: String? = nil,
        name: String? = nil,
        platform: String? = nil,
        version: String? = nil
    ) -> Client {
        return Client(
            instanceID: instanceID ?? self.instanceID,
            mode: mode ?? self.mode,
            name: name ?? self.name,
            platform: platform ?? self.platform,
            version: version ?? self.version
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Error
struct Error: Codable {
    let code: String
    let details: JSONAny?
    let message: String
    let retryable: Bool?
    let retryAfterMS: Int?

    enum CodingKeys: String, CodingKey {
        case code, details, message, retryable
        case retryAfterMS = "retryAfterMs"
    }
}

// MARK: Error convenience initializers and mutators

extension Error {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Error.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        code: String? = nil,
        details: JSONAny?? = nil,
        message: String? = nil,
        retryable: Bool?? = nil,
        retryAfterMS: Int?? = nil
    ) -> Error {
        return Error(
            code: code ?? self.code,
            details: details ?? self.details,
            message: message ?? self.message,
            retryable: retryable ?? self.retryable,
            retryAfterMS: retryAfterMS ?? self.retryAfterMS
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Features
struct Features: Codable {
    let events, methods: [String]
}

// MARK: Features convenience initializers and mutators

extension Features {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Features.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        events: [String]? = nil,
        methods: [String]? = nil
    ) -> Features {
        return Features(
            events: events ?? self.events,
            methods: methods ?? self.methods
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Policy
struct Policy: Codable {
    let maxBufferedBytes, maxPayload, tickIntervalMS: Int

    enum CodingKeys: String, CodingKey {
        case maxBufferedBytes, maxPayload
        case tickIntervalMS = "tickIntervalMs"
    }
}

// MARK: Policy convenience initializers and mutators

extension Policy {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Policy.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        maxBufferedBytes: Int? = nil,
        maxPayload: Int? = nil,
        tickIntervalMS: Int? = nil
    ) -> Policy {
        return Policy(
            maxBufferedBytes: maxBufferedBytes ?? self.maxBufferedBytes,
            maxPayload: maxPayload ?? self.maxPayload,
            tickIntervalMS: tickIntervalMS ?? self.tickIntervalMS
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Server
struct Server: Codable {
    let commit: String?
    let connID: String
    let host: String?
    let version: String

    enum CodingKeys: String, CodingKey {
        case commit
        case connID = "connId"
        case host, version
    }
}

// MARK: Server convenience initializers and mutators

extension Server {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Server.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        commit: String?? = nil,
        connID: String? = nil,
        host: String?? = nil,
        version: String? = nil
    ) -> Server {
        return Server(
            commit: commit ?? self.commit,
            connID: connID ?? self.connID,
            host: host ?? self.host,
            version: version ?? self.version
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Snapshot
struct Snapshot: Codable {
    let health: JSONAny
    let presence: [Presence]
    let stateVersion: SnapshotStateVersion
    let uptimeMS: Int

    enum CodingKeys: String, CodingKey {
        case health, presence, stateVersion
        case uptimeMS = "uptimeMs"
    }
}

// MARK: Snapshot convenience initializers and mutators

extension Snapshot {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Snapshot.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        health: JSONAny? = nil,
        presence: [Presence]? = nil,
        stateVersion: SnapshotStateVersion? = nil,
        uptimeMS: Int? = nil
    ) -> Snapshot {
        return Snapshot(
            health: health ?? self.health,
            presence: presence ?? self.presence,
            stateVersion: stateVersion ?? self.stateVersion,
            uptimeMS: uptimeMS ?? self.uptimeMS
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Presence
struct Presence: Codable {
    let host, instanceID, ip: String?
    let lastInputSeconds: Int?
    let mode, reason: String?
    let tags: [String]?
    let text: String?
    let ts: Int
    let version: String?

    enum CodingKeys: String, CodingKey {
        case host
        case instanceID = "instanceId"
        case ip, lastInputSeconds, mode, reason, tags, text, ts, version
    }
}

// MARK: Presence convenience initializers and mutators

extension Presence {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Presence.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        host: String?? = nil,
        instanceID: String?? = nil,
        ip: String?? = nil,
        lastInputSeconds: Int?? = nil,
        mode: String?? = nil,
        reason: String?? = nil,
        tags: [String]?? = nil,
        text: String?? = nil,
        ts: Int? = nil,
        version: String?? = nil
    ) -> Presence {
        return Presence(
            host: host ?? self.host,
            instanceID: instanceID ?? self.instanceID,
            ip: ip ?? self.ip,
            lastInputSeconds: lastInputSeconds ?? self.lastInputSeconds,
            mode: mode ?? self.mode,
            reason: reason ?? self.reason,
            tags: tags ?? self.tags,
            text: text ?? self.text,
            ts: ts ?? self.ts,
            version: version ?? self.version
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - SnapshotStateVersion
struct SnapshotStateVersion: Codable {
    let health, presence: Int
}

// MARK: SnapshotStateVersion convenience initializers and mutators

extension SnapshotStateVersion {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(SnapshotStateVersion.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        health: Int? = nil,
        presence: Int? = nil
    ) -> SnapshotStateVersion {
        return SnapshotStateVersion(
            health: health ?? self.health,
            presence: presence ?? self.presence
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ClawdisGatewayStateVersion
struct ClawdisGatewayStateVersion: Codable {
    let health, presence: Int
}

// MARK: ClawdisGatewayStateVersion convenience initializers and mutators

extension ClawdisGatewayStateVersion {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ClawdisGatewayStateVersion.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        health: Int? = nil,
        presence: Int? = nil
    ) -> ClawdisGatewayStateVersion {
        return ClawdisGatewayStateVersion(
            health: health ?? self.health,
            presence: presence ?? self.presence
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum TypeEnum: String, Codable {
    case event = "event"
    case hello = "hello"
    case helloError = "hello-error"
    case helloOk = "hello-ok"
    case req = "req"
    case res = "res"
}

// MARK: - Helper functions for creating encoders and decoders

func newJSONDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    if #available(iOS 10.0, OSX 10.12, tvOS 10.0, watchOS 3.0, *) {
        decoder.dateDecodingStrategy = .iso8601
    }
    return decoder
}

func newJSONEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    if #available(iOS 10.0, OSX 10.12, tvOS 10.0, watchOS 3.0, *) {
        encoder.dateEncodingStrategy = .iso8601
    }
    return encoder
}

// MARK: - Encode/decode helpers

class JSONNull: Codable, Hashable {

    public static func == (lhs: JSONNull, rhs: JSONNull) -> Bool {
            return true
    }

    public var hashValue: Int {
            return 0
    }

    public init() {}

    public required init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if !container.decodeNil() {
                    throw DecodingError.typeMismatch(JSONNull.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Wrong type for JSONNull"))
            }
    }

    public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encodeNil()
    }
}

class JSONCodingKey: CodingKey {
    let key: String

    required init?(intValue: Int) {
            return nil
    }

    required init?(stringValue: String) {
            key = stringValue
    }

    var intValue: Int? {
            return nil
    }

    var stringValue: String {
            return key
    }
}

class JSONAny: Codable {

    let value: Any

    static func decodingError(forCodingPath codingPath: [CodingKey]) -> DecodingError {
            let context = DecodingError.Context(codingPath: codingPath, debugDescription: "Cannot decode JSONAny")
            return DecodingError.typeMismatch(JSONAny.self, context)
    }

    static func encodingError(forValue value: Any, codingPath: [CodingKey]) -> EncodingError {
            let context = EncodingError.Context(codingPath: codingPath, debugDescription: "Cannot encode JSONAny")
            return EncodingError.invalidValue(value, context)
    }

    static func decode(from container: SingleValueDecodingContainer) throws -> Any {
            if let value = try? container.decode(Bool.self) {
                    return value
            }
            if let value = try? container.decode(Int64.self) {
                    return value
            }
            if let value = try? container.decode(Double.self) {
                    return value
            }
            if let value = try? container.decode(String.self) {
                    return value
            }
            if container.decodeNil() {
                    return JSONNull()
            }
            throw decodingError(forCodingPath: container.codingPath)
    }

    static func decode(from container: inout UnkeyedDecodingContainer) throws -> Any {
            if let value = try? container.decode(Bool.self) {
                    return value
            }
            if let value = try? container.decode(Int64.self) {
                    return value
            }
            if let value = try? container.decode(Double.self) {
                    return value
            }
            if let value = try? container.decode(String.self) {
                    return value
            }
            if let value = try? container.decodeNil() {
                    if value {
                            return JSONNull()
                    }
            }
            if var container = try? container.nestedUnkeyedContainer() {
                    return try decodeArray(from: &container)
            }
            if var container = try? container.nestedContainer(keyedBy: JSONCodingKey.self) {
                    return try decodeDictionary(from: &container)
            }
            throw decodingError(forCodingPath: container.codingPath)
    }

    static func decode(from container: inout KeyedDecodingContainer<JSONCodingKey>, forKey key: JSONCodingKey) throws -> Any {
            if let value = try? container.decode(Bool.self, forKey: key) {
                    return value
            }
            if let value = try? container.decode(Int64.self, forKey: key) {
                    return value
            }
            if let value = try? container.decode(Double.self, forKey: key) {
                    return value
            }
            if let value = try? container.decode(String.self, forKey: key) {
                    return value
            }
            if let value = try? container.decodeNil(forKey: key) {
                    if value {
                            return JSONNull()
                    }
            }
            if var container = try? container.nestedUnkeyedContainer(forKey: key) {
                    return try decodeArray(from: &container)
            }
            if var container = try? container.nestedContainer(keyedBy: JSONCodingKey.self, forKey: key) {
                    return try decodeDictionary(from: &container)
            }
            throw decodingError(forCodingPath: container.codingPath)
    }

    static func decodeArray(from container: inout UnkeyedDecodingContainer) throws -> [Any] {
            var arr: [Any] = []
            while !container.isAtEnd {
                    let value = try decode(from: &container)
                    arr.append(value)
            }
            return arr
    }

    static func decodeDictionary(from container: inout KeyedDecodingContainer<JSONCodingKey>) throws -> [String: Any] {
            var dict = [String: Any]()
            for key in container.allKeys {
                    let value = try decode(from: &container, forKey: key)
                    dict[key.stringValue] = value
            }
            return dict
    }

    static func encode(to container: inout UnkeyedEncodingContainer, array: [Any]) throws {
            for value in array {
                    if let value = value as? Bool {
                            try container.encode(value)
                    } else if let value = value as? Int64 {
                            try container.encode(value)
                    } else if let value = value as? Double {
                            try container.encode(value)
                    } else if let value = value as? String {
                            try container.encode(value)
                    } else if value is JSONNull {
                            try container.encodeNil()
                    } else if let value = value as? [Any] {
                            var container = container.nestedUnkeyedContainer()
                            try encode(to: &container, array: value)
                    } else if let value = value as? [String: Any] {
                            var container = container.nestedContainer(keyedBy: JSONCodingKey.self)
                            try encode(to: &container, dictionary: value)
                    } else {
                            throw encodingError(forValue: value, codingPath: container.codingPath)
                    }
            }
    }

    static func encode(to container: inout KeyedEncodingContainer<JSONCodingKey>, dictionary: [String: Any]) throws {
            for (key, value) in dictionary {
                    let key = JSONCodingKey(stringValue: key)!
                    if let value = value as? Bool {
                            try container.encode(value, forKey: key)
                    } else if let value = value as? Int64 {
                            try container.encode(value, forKey: key)
                    } else if let value = value as? Double {
                            try container.encode(value, forKey: key)
                    } else if let value = value as? String {
                            try container.encode(value, forKey: key)
                    } else if value is JSONNull {
                            try container.encodeNil(forKey: key)
                    } else if let value = value as? [Any] {
                            var container = container.nestedUnkeyedContainer(forKey: key)
                            try encode(to: &container, array: value)
                    } else if let value = value as? [String: Any] {
                            var container = container.nestedContainer(keyedBy: JSONCodingKey.self, forKey: key)
                            try encode(to: &container, dictionary: value)
                    } else {
                            throw encodingError(forValue: value, codingPath: container.codingPath)
                    }
            }
    }

    static func encode(to container: inout SingleValueEncodingContainer, value: Any) throws {
            if let value = value as? Bool {
                    try container.encode(value)
            } else if let value = value as? Int64 {
                    try container.encode(value)
            } else if let value = value as? Double {
                    try container.encode(value)
            } else if let value = value as? String {
                    try container.encode(value)
            } else if value is JSONNull {
                    try container.encodeNil()
            } else {
                    throw encodingError(forValue: value, codingPath: container.codingPath)
            }
    }

    public required init(from decoder: Decoder) throws {
            if var arrayContainer = try? decoder.unkeyedContainer() {
                    self.value = try JSONAny.decodeArray(from: &arrayContainer)
            } else if var container = try? decoder.container(keyedBy: JSONCodingKey.self) {
                    self.value = try JSONAny.decodeDictionary(from: &container)
            } else {
                    let container = try decoder.singleValueContainer()
                    self.value = try JSONAny.decode(from: container)
            }
    }

    public func encode(to encoder: Encoder) throws {
            if let arr = self.value as? [Any] {
                    var container = encoder.unkeyedContainer()
                    try JSONAny.encode(to: &container, array: arr)
            } else if let dict = self.value as? [String: Any] {
                    var container = encoder.container(keyedBy: JSONCodingKey.self)
                    try JSONAny.encode(to: &container, dictionary: dict)
            } else {
                    var container = encoder.singleValueContainer()
                    try JSONAny.encode(to: &container, value: self.value)
            }
    }
}
