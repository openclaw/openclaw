import Foundation

/// Shared by a Mac Gateway connection and its outbox; no ownership survives a process restart.
public final class OpenClawChatSendOwnership: @unchecked Sendable {
    public struct Scope: Hashable, Sendable {
        public let sessionKey: String
        public let agentID: String?

        public init(
            sessionKey: String,
            agentID: String?,
            scope: String? = nil,
            mainKey: String? = nil,
            defaultAgentID: String? = nil)
        {
            let key = OpenClawChatSessionKey.canonicalOwnershipKey(sessionKey)
            let owner = OpenClawChatSessionKey.agentID(from: key) ?? agentID ?? defaultAgentID
            self.agentID = owner?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let main = mainKey?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "main"
            let parts = key.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
            let qualified = parts.count == 3 && parts[0] == "agent"
            let suffix = qualified ? String(parts[2]) : key
            if key == "global" || key == "unknown" {
                self.sessionKey = key
            } else if let agent = self.agentID, suffix == "main" || suffix == main {
                self.sessionKey = scope == "global" ? "global" : "agent:\(agent):\(main)"
            } else if !qualified, let agent = self.agentID {
                self.sessionKey = "agent:\(agent):\(key)"
            } else {
                self.sessionKey = key
            }
        }

        public init(sessionKey: String, agentID: String?, routingContract: String?) {
            let routing = OpenClawChatSessionRoutingContract.parse(routingContract)
            self.init(
                sessionKey: sessionKey,
                agentID: agentID,
                scope: routing?.scope,
                mainKey: routing?.mainKey,
                defaultAgentID: routing?.defaultAgentID)
        }
    }

    private let lock = NSLock()
    private var observers: [UUID: AsyncStream<Void>.Continuation] = [:]
    private var nativeClaims: [Scope: Int] = [:]
    private var webClaims: [Scope: Set<UUID>] = [:]

    public init() {}

    public func changes() -> AsyncStream<Void> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.lock.withLock { self.observers[id] = continuation }
        continuation.onTermination = { [weak self] _ in
            _ = self?.lock.withLock { self?.observers.removeValue(forKey: id) }
        }
        return stream
    }

    public func beginNative(_ scope: Scope) -> Bool {
        self.lock.withLock {
            guard self.webClaims[scope]?.isEmpty != false else { return false }
            self.nativeClaims[scope, default: 0] += 1
            return true
        }
    }

    public func endNative(_ scope: Scope) {
        let observers = self.lock.withLock {
            if self.nativeClaims[scope] == 1 {
                self.nativeClaims.removeValue(forKey: scope)
            } else if let count = self.nativeClaims[scope] {
                self.nativeClaims[scope] = count - 1
            }
            return Array(self.observers.values)
        }
        for observer in observers {
            observer.yield(())
        }
    }

    public func beginWeb(_ scope: Scope, owner: UUID) -> Bool {
        self.lock.withLock {
            guard self.nativeClaims[scope] == nil else { return false }
            self.webClaims[scope, default: []].insert(owner)
            return true
        }
    }

    public func endWeb(_ scope: Scope, owner: UUID) {
        self.lock.withLock {
            self.webClaims[scope]?.remove(owner)
            if self.webClaims[scope]?.isEmpty == true { self.webClaims.removeValue(forKey: scope) }
        }
    }
}

extension OpenClawChatSessionKey {
    /// Mirrors session-url-contract/session-key-normalization.ts. Folding opaque IDs
    /// would merge distinct conversations; failing to fold structure splits ownership.
    fileprivate static func canonicalOwnershipKey(_ value: String) -> String {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines) as NSString
        let full = NSRange(location: 0, length: raw.length)
        var spans: [(range: NSRange, trim: Bool)] = []
        let signal = try? NSRegularExpression(pattern: "(^|:)signal:group:([^:]+)", options: .caseInsensitive)
        for match in signal?.matches(in: raw as String, range: full) ?? [] {
            spans.append((match.range(at: 2), true))
        }
        let matrix = try? NSRegularExpression(
            pattern: "^(?:(?:agent:[^:]*:)+:*)?matrix:(?:channel|group):", options: .caseInsensitive)
        if let match = matrix?.firstMatch(in: raw as String, range: full), NSMaxRange(match.range) < raw.length {
            let start = NSMaxRange(match.range)
            let tail = NSRange(location: start, length: raw.length - start)
            let thread = raw.range(of: ":thread:", options: [.caseInsensitive, .backwards], range: tail)
            if thread.location == NSNotFound {
                spans.append((tail, false))
            } else {
                spans.append((NSRange(location: start, length: thread.location - start), false))
                spans.append((NSRange(location: NSMaxRange(thread), length: raw.length - NSMaxRange(thread)), false))
            }
        }
        var cursor = 0
        var result = ""
        for span in spans.filter({ $0.range.length > 0 }).sorted(by: { $0.range.location < $1.range.location }) {
            // Matrix tails may contain Signal-shaped text. The outer opaque span wins.
            guard span.range.location >= cursor else { continue }
            result += raw.substring(with: NSRange(location: cursor, length: span.range.location - cursor))
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let preserved = raw.substring(with: span.range)
            result += span.trim ? preserved.trimmingCharacters(in: .whitespacesAndNewlines) : preserved
            cursor = NSMaxRange(span.range)
        }
        result += raw.substring(from: cursor).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return result
    }
}

public enum OpenClawChatSendOwnershipError: LocalizedError {
    case webOwned
    public var errorDescription: String? {
        String(
            localized: """
            This conversation is open in a web pane. Send from that chat window, or close it before sending here.
            """)
    }
}
