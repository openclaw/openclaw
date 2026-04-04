import Foundation

struct ResolvedSessionIdentity: Equatable, Sendable {
    let canonicalSessionKey: String
    let sessionID: String?
    let agentID: String?
    let subjectID: String
    let subjectRole: String
    let seatLabel: String
    let caseLabel: String
    let contextLabel: String?
    let isPrimaryBot: Bool
}

struct SessionIdentitySnapshot: Equatable, Sendable {
    static let empty = Self(identitiesByLookupKey: [:], identitiesByAgentID: [:], primaryBot: nil)

    let identitiesByLookupKey: [String: ResolvedSessionIdentity]
    let identitiesByAgentID: [String: ResolvedSessionIdentity]
    let primaryBot: ResolvedSessionIdentity?

    func resolve(sessionKey: String?) -> ResolvedSessionIdentity? {
        let normalized = SessionIdentityStore.normalizeLookupKey(sessionKey)
        guard !normalized.isEmpty else { return self.primaryBot }
        if let exact = self.identitiesByLookupKey[normalized] {
            return exact
        }
        if let parsed = SessionIdentityStore.parseAgentSessionKey(normalized),
           let byAgent = self.identitiesByAgentID[parsed.agentID]
        {
            return byAgent
        }
        if normalized == "main" {
            return self.primaryBot
        }
        return nil
    }
}

enum SessionIdentityStore {
    @MainActor
    static func loadSnapshot(limit: Int? = 200) async -> SessionIdentitySnapshot? {
        do {
            let snapshot = try await SessionLoader.loadSnapshot(
                limit: limit,
                includeGlobal: true,
                includeUnknown: true)
            let mainSessionKey = await GatewayConnection.shared.mainSessionKey(timeoutMs: 5000)
            return self.makeSnapshot(rows: snapshot.rows, mainSessionKey: mainSessionKey)
        } catch {
            return nil
        }
    }

    static func fallbackIdentity(for sessionKey: String, role: SessionRole) -> ResolvedSessionIdentity {
        let normalized = self.normalizeLookupKey(sessionKey)
        let parsed = self.parseAgentSessionKey(normalized)
        let agentID = parsed?.agentID
        let isPrimaryBot = role == .main
        let caseLabel = isPrimaryBot
            ? "Primary bot"
            : (agentID.flatMap(self.humanizeAgentID) ?? self.fallbackCaseLabel(for: normalized))
        let seatLabel = isPrimaryBot ? "Primary bot" : "Bot: \(caseLabel)"
        let subjectRole = isPrimaryBot ? "primary-bot" : (agentID == nil ? "session" : "bot")
        return ResolvedSessionIdentity(
            canonicalSessionKey: normalized.nonEmpty ?? "main",
            sessionID: nil,
            agentID: agentID,
            subjectID: self.subjectID(
                agentID: agentID,
                sessionID: nil,
                normalizedSessionKey: normalized.nonEmpty ?? "main"),
            subjectRole: subjectRole,
            seatLabel: seatLabel,
            caseLabel: caseLabel,
            contextLabel: normalized.nonEmpty,
            isPrimaryBot: isPrimaryBot)
    }

    static func makeSnapshot(rows: [SessionRow], mainSessionKey: String) -> SessionIdentitySnapshot {
        let normalizedMainSessionKey = self.normalizeLookupKey(mainSessionKey)
        var identitiesByLookupKey: [String: ResolvedSessionIdentity] = [:]
        var identitiesByAgentID: [String: ResolvedSessionIdentity] = [:]
        var primaryBot: ResolvedSessionIdentity?

        for row in rows {
            let identity = self.identity(for: row, normalizedMainSessionKey: normalizedMainSessionKey)
            self.register(identity, for: row.key, into: &identitiesByLookupKey)
            if let parsed = self.parseAgentSessionKey(row.key) {
                self.register(identity, for: "agent:\(parsed.agentID):\(parsed.rest)", into: &identitiesByLookupKey)
                identitiesByAgentID[parsed.agentID] = identitiesByAgentID[parsed.agentID] ?? identity
                if identity.isPrimaryBot {
                    self.register(identity, for: "main", into: &identitiesByLookupKey)
                }
            }
            if identity.isPrimaryBot {
                primaryBot = primaryBot ?? identity
            }
        }

        if primaryBot == nil {
            primaryBot = identitiesByLookupKey["main"] ?? identitiesByAgentID["main"]
        }

        return SessionIdentitySnapshot(
            identitiesByLookupKey: identitiesByLookupKey,
            identitiesByAgentID: identitiesByAgentID,
            primaryBot: primaryBot)
    }

    static func normalizeLookupKey(_ raw: String?) -> String {
        (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func parseAgentSessionKey(_ raw: String?) -> (agentID: String, rest: String)? {
        let normalized = self.normalizeLookupKey(raw)
        guard !normalized.isEmpty else { return nil }
        let parts = normalized.split(separator: ":", omittingEmptySubsequences: true)
        guard parts.count >= 3, parts[0] == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        let rest = parts.dropFirst(2).joined(separator: ":")
        guard let agentID = agentID.nonEmpty, let rest = rest.nonEmpty else { return nil }
        return (agentID, rest)
    }

    private static func identity(
        for row: SessionRow,
        normalizedMainSessionKey: String) -> ResolvedSessionIdentity
    {
        let normalizedSessionKey = self.normalizeLookupKey(row.key)
        let parsed = self.parseAgentSessionKey(normalizedSessionKey)
        let agentID = parsed?.agentID
        let isCanonicalMainBot = parsed?.agentID == "main" && parsed?.rest == "main"
        let isPrimaryBot =
            normalizedSessionKey == normalizedMainSessionKey ||
            (normalizedMainSessionKey == "main" && isCanonicalMainBot)

        let contextLabel = self.contextLabel(for: row)
        let agentLabel = agentID.flatMap(self.humanizeAgentID)
        let caseLabel: String
        if isPrimaryBot {
            caseLabel = "Primary bot"
        } else if let agentLabel {
            caseLabel = agentLabel
        } else if let contextLabel {
            caseLabel = contextLabel
        } else if let sessionID = row.sessionId?.nonEmpty {
            caseLabel = self.sessionLabel(for: sessionID)
        } else {
            caseLabel = row.key
        }

        let seatLabel: String
        if isPrimaryBot {
            seatLabel = "Primary bot"
        } else if let agentLabel {
            seatLabel = "Bot: \(agentLabel)"
        } else {
            seatLabel = "Bot: \(caseLabel)"
        }

        return ResolvedSessionIdentity(
            canonicalSessionKey: normalizedSessionKey.nonEmpty ?? row.key,
            sessionID: row.sessionId?.nonEmpty,
            agentID: agentID,
            subjectID: self.subjectID(
                agentID: agentID,
                sessionID: row.sessionId?.nonEmpty,
                normalizedSessionKey: normalizedSessionKey.nonEmpty ?? row.key),
            subjectRole: isPrimaryBot ? "primary-bot" : (agentID == nil ? "session" : "bot"),
            seatLabel: seatLabel,
            caseLabel: caseLabel,
            contextLabel: contextLabel,
            isPrimaryBot: isPrimaryBot)
    }

    private static func register(
        _ identity: ResolvedSessionIdentity,
        for lookupKey: String,
        into index: inout [String: ResolvedSessionIdentity])
    {
        let normalized = self.normalizeLookupKey(lookupKey)
        guard !normalized.isEmpty else { return }
        index[normalized] = index[normalized] ?? identity
    }

    private static func subjectID(
        agentID: String?,
        sessionID: String?,
        normalizedSessionKey: String) -> String
    {
        if let agentID {
            return "bot:\(agentID)"
        }
        if normalizedSessionKey == "global" {
            return "system:global"
        }
        if let sessionID {
            return "session:\(sessionID.lowercased())"
        }
        return "session:\(normalizedSessionKey)"
    }

    private static func contextLabel(for row: SessionRow) -> String? {
        if let displayName = row.displayName?.nonEmpty {
            return displayName
        }
        let parts = [row.subject?.nonEmpty, row.room?.nonEmpty, row.space?.nonEmpty].compactMap { $0 }
        if !parts.isEmpty {
            return parts.joined(separator: " / ")
        }
        if let sessionID = row.sessionId?.nonEmpty {
            return self.sessionLabel(for: sessionID)
        }
        return nil
    }

    private static func fallbackCaseLabel(for normalizedSessionKey: String) -> String {
        if let parsed = self.parseAgentSessionKey(normalizedSessionKey),
           let label = self.humanizeAgentID(parsed.agentID)
        {
            return label
        }
        if normalizedSessionKey == "main" {
            return "Primary bot"
        }
        return normalizedSessionKey.nonEmpty ?? "Bot"
    }

    private static func humanizeAgentID(_ raw: String) -> String? {
        let normalized = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
        return normalized.nonEmpty
    }

    private static func sessionLabel(for sessionID: String) -> String {
        let prefix = String(sessionID.prefix(8))
        return "Session \(prefix)"
    }
}
