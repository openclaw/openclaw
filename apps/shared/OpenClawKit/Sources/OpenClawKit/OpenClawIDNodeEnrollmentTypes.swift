import Foundation

/// Stable failures never include the join secret, signature header or remote response text.
public enum OpenClawIDNodeEnrollmentError: Error, Sendable, Equatable {
    case malformed, unsupportedVersion, invalidLink, discoveryOriginRequired
    case keychain(Int32), invalidIdentity, badSignature, rootMismatch, wrongClaw, wrongHost
    case rollback, staleSnapshot, notAdmitted, timeout, responseTooLarge, redirect, unavailable
    case discoveryRejected(Int)
}

/// The actual node command/capability manifest frozen for an enrollment attempt.
public struct OpenClawIDNodeEnrollmentDescription: Sendable, Equatable {
    public let displayName: String
    public let platform: String
    public let commands: [String]
    public let caps: [String]

    /// Validates protocol limits without dropping or inventing advertised commands.
    public init(displayName: String, platform: String, commands: [String], caps: [String]) throws {
        try Self.validateText(displayName, maximum: 128)
        try Self.validateText(platform, maximum: 64)
        for list in [commands, caps] {
            guard list.count <= 64, Set(list.map { Data($0.utf8) }).count == list.count else {
                throw OpenClawIDNodeEnrollmentError.malformed
            }
            for item in list { try Self.validateText(item, maximum: 128) }
        }
        self.displayName = displayName
        self.platform = platform
        self.commands = commands
        self.caps = caps
    }

    var json: OpenClawIDCanonicalJSON {
        .object(["display_name": .string(displayName), "platform": .string(platform),
                 "commands": .array(commands.map { .string($0) }), "caps": .array(caps.map { .string($0) })])
    }

    private static func validateText(_ value: String, maximum: Int) throws {
        guard !value.isEmpty, value.utf16.count <= maximum,
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
        else { throw OpenClawIDNodeEnrollmentError.malformed }
    }
}

/// Fragment-only invite input. This is transient secret material, never Codable or logged.
public struct OpenClawIDNodeEnrollmentLink: Sendable {
    public let clawID: String
    public let inviteID: String
    public let rootFingerprint: String
    public let hostname: String
    public let relayURL: URL
    private var secret: Data

    // Erase the owned invite bytes once the signed redemption is prepared. Swift may retain COW copies;
    // callers must also discard their pasted link, and no zeroization of the caller's String is claimed.
    mutating func consumeSecret<T>(_ body: (Data) throws -> T) rethrows -> T {
        defer { secret.resetBytes(in: 0..<secret.count); secret.removeAll(keepingCapacity: false) }
        return try body(secret)
    }

    /// Strictly decodes the protocol's five-field link, rejecting duplicate and unknown fields.
    public init(_ text: String) throws {
        guard text.utf16.count <= 2048, text.hasPrefix("openclaw-node://join#"),
              let url = URLComponents(string: text), url.scheme == "openclaw-node", url.host == "join",
              url.port == nil, url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil,
              let fragment = url.percentEncodedFragment
        else { throw OpenClawIDNodeEnrollmentError.invalidLink }
        var fields: [String: String] = [:]
        for pair in fragment.split(separator: "&", omittingEmptySubsequences: false) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2,
                  let key = String(parts[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let value = String(parts[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  fields[key] == nil
            else { throw OpenClawIDNodeEnrollmentError.invalidLink }
            fields[key] = value
        }
        guard Set(fields.keys) == ["i", "c", "r", "h", "relay"] else {
            throw OpenClawIDNodeEnrollmentError.invalidLink
        }
        let invite = fields["i"]!.split(separator: ".", omittingEmptySubsequences: false)
        guard invite.count == 2, Self.matches(String(invite[0]), "^[0-9a-f]{32}$"),
              Self.matches(fields["c"]!, "^[0-9a-f]{32}$"), Self.matches(fields["r"]!, "^[0-9a-f]{64}$"),
              Self.validHostname(fields["h"]!)
        else { throw OpenClawIDNodeEnrollmentError.invalidLink }
        self.secret = try OpenClawIDNodeIdentity.decodeBase64URL(String(invite[1]), count: 32)
        self.inviteID = String(invite[0])
        self.clawID = fields["c"]!
        self.rootFingerprint = "fp:" + fields["r"]!
        self.hostname = fields["h"]!
        self.relayURL = try Self.routingURL(fields["relay"]!, originOnly: false)
    }

    /// Discovery is supplied separately; no hostname/relay inference or deployment default exists.
    public static func discoveryOrigin(_ text: String) throws -> URL {
        guard !text.isEmpty else { throw OpenClawIDNodeEnrollmentError.discoveryOriginRequired }
        return try self.routingURL(text, originOnly: true)
    }

    static func matches(_ value: String, _ pattern: String) -> Bool {
        guard let range = value.range(of: pattern, options: .regularExpression) else { return false }
        return range.lowerBound == value.startIndex && range.upperBound == value.endIndex
    }

    static func validHostname(_ value: String) -> Bool {
        value.utf16.count <= 253 && matches(value,
            "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$")
    }

    static func routingURL(_ text: String, originOnly: Bool) throws -> URL {
        guard text.utf16.count <= 512, !text.contains("\\"),
              !text.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              let parts = URLComponents(string: text), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)),
              !originOnly || parts.path.isEmpty || parts.path == "/", let url = parts.url
        else { throw OpenClawIDNodeEnrollmentError.invalidLink }
        return url
    }
}
