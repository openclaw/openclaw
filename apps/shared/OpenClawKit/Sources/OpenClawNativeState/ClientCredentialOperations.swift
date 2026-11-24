import Foundation
import SQLite3

extension OpenClawClientCredentialStore {
    /// Match ECMAScript String.trim for raw observations received from TypeScript.
    private static let tokenTrimCharacters = CharacterSet(charactersIn:
        "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}" +
            "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}" +
            "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    public func execute(_ operation: ClientCredentialOperation) throws -> ClientCredentialResult {
        func missing() -> OpenClawNativeStateError {
            .init("Invalid local credential operation")
        }
        switch operation.kind {
        case .identityRead:
            guard let key = operation.identity_key else { throw missing() }
            var result = ClientCredentialResult(kind: .identity)
            result.identity = try readIdentity(key: key)
            return result
        case .identityCreate:
            guard let identity = operation.identity else { throw missing() }
            var result = ClientCredentialResult(kind: .identity)
            result.identity = try createIdentity(identity)
            return result
        case .identityRepair:
            throw OpenClawNativeStateError("Identity repair requires the local migration owner")
        case .tokenRead, .tokenReplace, .tokenRemove, .tokenList:
            return try self.tokenOperation(operation)
        case .socketRead:
            var result = ClientCredentialResult(kind: .socket)
            result.socket = try readSocketCredentials()
            return result
        case .socketEnsure:
            guard let fallback = operation.fallback else { throw missing() }
            var result = ClientCredentialResult(kind: .socket)
            result.socket = try self.ensureSocket(fallback: fallback, requested: operation.requested)
            return result
        case .nativeTokensClear:
            guard let deviceID = operation.device_id, let selector = operation.selector else { throw missing() }
            guard selector.kind != .role || selector.role?.isEmpty == false,
                  selector.kind != .gateway || selector.gateway?.isEmpty == false else { throw missing() }
            var result = ClientCredentialResult(kind: .cleared)
            result.count = try self.clearNativeTokens(deviceID: deviceID, selector: selector)
            return result
        case .nativeTokenClaim:
            guard let deviceID = operation.device_id, let role = operation.role, let gateway = operation.gateway else {
                throw missing()
            }
            var result = ClientCredentialResult(kind: .changed)
            result.changed = try self.claimNativeToken(deviceID: deviceID, role: role, gateway: gateway)
            return result
        }
    }

    private func ensureSocket(
        fallback: SocketCredentials, requested: ClientCredentialOperation.RequestedSocket?) throws -> SocketCredentials
    {
        try transaction {
            let current = try self.readSocketCredentials()
            func requestedValue(_ value: String?) -> String? {
                let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed?.isEmpty == false ? trimmed : nil
            }
            let historicalPath = self.rootURL.appendingPathComponent("exec-approvals.sock").path
            let existingPath = current?.path
            let useFallbackPath = existingPath?.isEmpty != false ||
                (Self.sameUTF8Bytes(existingPath, historicalPath) && !Self.sameUTF8Bytes(fallback.path, historicalPath))
            let path = requestedValue(requested?.path) ??
                (useFallbackPath ? fallback.path : existingPath)
            let token = requestedValue(requested?.token) ??
                (current?.token?.isEmpty == false ? current?.token : fallback.token)
            if let current, Self.sameUTF8Bytes(current.path, path), Self.sameUTF8Bytes(current.token, token) {
                return current
            }
            let next = SocketCredentials(path: path, token: token, updatedAtMs: fallback.updatedAtMs)
            try self.run(
                "INSERT INTO native_exec_socket_credentials VALUES ('current',?,?,?) " +
                    "ON CONFLICT(socket_key) DO UPDATE SET socket_path=excluded.socket_path," +
                    "socket_token=excluded.socket_token,updated_at_ms=excluded.updated_at_ms",
                [path.map(Value.text) ?? .null, token.map(Value.text) ?? .null, .integer(next.updatedAtMs)])
            return next
        }
    }

    private func tokenOperation(_ operation: ClientCredentialOperation) throws -> ClientCredentialResult {
        func missing() -> OpenClawNativeStateError {
            .init("Invalid local token operation")
        }
        switch operation.kind {
        case .tokenRead:
            guard let key = operation.key else { throw missing() }
            var result = ClientCredentialResult(kind: .token)
            result.token = try readToken(deviceID: key.device_id, role: key.role, gatewayScope: key.gateway_scope)
            return result
        case .tokenReplace:
            guard let key = operation.key, let token = operation.token else { throw missing() }
            var result = ClientCredentialResult(kind: .changed)
            if operation.hasExpectedToken {
                result.changed = try replaceToken(
                    Token(
                        deviceID: key.device_id,
                        role: key.role,
                        gatewayScope: key.gateway_scope,
                        token: token.token,
                        scopesJSON: token.scopesJSON,
                        updatedAtMs: token.updatedAtMs),
                    expectedToken: operation.expectedToken)
            } else {
                result.changed = try transaction {
                    try self.writeToken(token, key: key)
                    return true
                }
            }
            return result
        case .tokenRemove:
            guard let key = operation.key else { throw missing() }
            var result = ClientCredentialResult(kind: .changed)
            result.changed = try transaction {
                let table = key.gateway_scope == nil ? "device_auth_tokens" : "gateway_origin_device_tokens"
                var predicate = "device_id=? AND role=?"
                var values: [Value] = [.text(key.device_id), .text(key.role)]
                if let scope = key.gateway_scope {
                    predicate += " AND gateway_scope=?"
                    values.append(.text(scope))
                }
                if operation.hasExpectedToken || operation.observedToken != nil {
                    let current = try self.query(
                        "SELECT token FROM \(table) WHERE \(predicate)",
                        values) { try Self.text($0, 0) }
                    let matchesExpected = operation.hasExpectedToken &&
                        Self.sameUTF8Bytes(current, operation.expectedToken)
                    let matchesObserved = operation.observedToken.map { observed in
                        Self.sameUTF8Bytes(current, observed) &&
                            (!operation.hasExpectedToken || Self.sameUTF8Bytes(
                                observed.trimmingCharacters(in: Self.tokenTrimCharacters),
                                operation.expectedToken))
                    } ?? false
                    guard matchesExpected || matchesObserved, let current else { return false }
                    predicate += " AND token=?"
                    values.append(.text(current))
                }
                try self.run("DELETE FROM \(table) WHERE \(predicate)", values)
                return try self.query("SELECT changes()") { sqlite3_column_int($0, 0) != 0 } ?? false
            }
            return result
        case .tokenList:
            guard let deviceID = operation.device_id else { throw missing() }
            var result = ClientCredentialResult(kind: .tokens)
            var rows: [Token] = []
            let limit = min(32, max(1, operation.limit ?? 32))
            let table = operation.gateway_scope == nil ? "device_auth_tokens" : "gateway_origin_device_tokens"
            var values: [Value] = [.text(deviceID), .text(operation.afterRole ?? "")]
            if let scope = operation.gateway_scope { values.append(.text(scope)) }
            values.append(.integer(Int64(limit + 1)))
            try transaction {
                try self.withStatement(
                    "SELECT role, token, scopes_json, updated_at_ms FROM \(table) " +
                        "WHERE device_id=? AND role>? " +
                        (operation.gateway_scope == nil ? "" : "AND gateway_scope=? ") + "ORDER BY role LIMIT ?",
                    values)
                { statement in
                    while true {
                        let step = sqlite3_step(statement)
                        if step == SQLITE_DONE { break }
                        guard step == SQLITE_ROW
                        else { throw OpenClawNativeStateError("Could not read local credential rows") }
                        try rows.append(Token(
                            deviceID: deviceID,
                            role: Self.text(statement, 0),
                            token: Self.text(statement, 1),
                            scopesJSON: Self.text(statement, 2),
                            updatedAtMs: sqlite3_column_int64(statement, 3)))
                    }
                }
            }
            if rows.count > limit {
                rows.removeLast()
                result.nextRole = rows.last?.role
            }
            result.tokens = rows
            return result
        default: throw missing()
        }
    }

    private func writeToken(_ token: Token, key: ClientCredentialOperation.TokenKey) throws {
        let table = key.gateway_scope == nil ? "device_auth_tokens" : "gateway_origin_device_tokens"
        let columns = "device_id,role,token,scopes_json,updated_at_ms"
        var values: [Value] = [
            .text(key.device_id),
            .text(key.role),
            .text(token.token),
            .text(token.scopesJSON),
            .integer(token.updatedAtMs),
        ]
        if let scope = key.gateway_scope {
            values.insert(.text(scope), at: 0)
        }
        try run(
            "INSERT INTO \(table) (\(key.gateway_scope == nil ? "" : "gateway_scope,")\(columns)) " +
                "VALUES (\(values.map { _ in "?" }.joined(separator: ","))) ON CONFLICT DO UPDATE SET " +
                "token=excluded.token,scopes_json=excluded.scopes_json,updated_at_ms=excluded.updated_at_ms",
            values)
    }

    private func clearNativeTokens(deviceID: String, selector: ClientCredentialOperation.Selector) throws -> Int {
        try transaction {
            var keys: [String] = []
            try self
                .withStatement(
                    "SELECT role FROM device_auth_tokens WHERE device_id=?",
                    [.text(deviceID)])
                { statement in
                    while true {
                        let step = sqlite3_step(statement)
                        if step == SQLITE_DONE { break }
                        guard step == SQLITE_ROW
                        else { throw OpenClawNativeStateError("Could not read local credential rows") }
                        let key = try Self.text(statement, 0)
                        let decoded = NativeCredentialTokenKey.decode(key)
                        let matches: Bool = switch selector.kind {
                        case .all: true
                        case .role: Self.sameUTF8Bytes(decoded.role, selector.role)
                        case .gateway: Self.sameUTF8Bytes(decoded.gateway, selector.gateway)
                        case .unscoped: decoded.gateway == nil
                        }
                        if matches {
                            keys.append(key)
                        }
                    }
                }
            for key in keys {
                try self.run(
                    "DELETE FROM device_auth_tokens WHERE device_id=? AND role=?",
                    [.text(deviceID), .text(key)])
            }
            return keys.count
        }
    }

    private func claimNativeToken(deviceID: String, role: String, gateway: String) throws -> Bool {
        try transaction {
            guard let token = try self.query(
                "SELECT token,scopes_json,updated_at_ms FROM device_auth_tokens WHERE device_id=? AND role=?",
                [.text(deviceID), .text(role)],
                { statement in
                    try Token(
                        deviceID: deviceID,
                        role: role,
                        token: Self.text(statement, 0),
                        scopesJSON: Self.text(statement, 1),
                        updatedAtMs: sqlite3_column_int64(statement, 2))
                }) else { return false }
            let key = NativeCredentialTokenKey.encode(role: role, gateway: gateway)
            try self.run(
                "INSERT INTO device_auth_tokens VALUES (?,?,?,?,?) ON CONFLICT(device_id,role) DO NOTHING",
                [.text(deviceID), .text(key), .text(token.token), .text(token.scopesJSON), .integer(token.updatedAtMs)])
            try self.run("DELETE FROM device_auth_tokens WHERE device_id=? AND role=?", [.text(deviceID), .text(role)])
            return true
        }
    }
}

public enum NativeCredentialTokenKey {
    public static func encode(role: String, gateway: String?) -> String {
        guard let gateway else { return role }
        func component(_ value: String) -> String {
            Data(value.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
                of: "/",
                with: "_").replacingOccurrences(of: "=", with: "")
        }
        return "v2.\(component(gateway)).\(component(role))"
    }

    public static func decode(_ key: String) -> (role: String, gateway: String?) {
        let parts = key.split(separator: ".", omittingEmptySubsequences: false)
        func component(_ value: Substring) -> String? {
            let base = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            guard let data = Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4))
            else { return nil }
            return String(data: data, encoding: .utf8)
        }
        guard parts.count == 3, parts[0] == "v2", let gateway = component(parts[1]),
              let role = component(parts[2])
        else { return (
            key,
            nil) }
        return (role, gateway)
    }
}
