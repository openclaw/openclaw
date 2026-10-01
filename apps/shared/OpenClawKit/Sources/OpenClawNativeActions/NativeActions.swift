import Foundation

/// Public selectors, never credentials or authority. Adapters must verify the
/// profile on the selected live connection before opening or submitting work.
public struct OpenClawNativeOwnerRef: Codable, Hashable, Sendable {
    public let gatewayID: String
    public let profileID: String

    public init(gatewayID: String, profileID: String) {
        self.gatewayID = gatewayID
        self.profileID = profileID
    }

    /// Gateway namespaces preserve UTF-8 identity, including Unicode spelling.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.gatewayID.utf8.elementsEqual(rhs.gatewayID.utf8) &&
            lhs.profileID.utf8.elementsEqual(rhs.profileID.utf8)
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(Data(self.gatewayID.utf8))
        hasher.combine(Data(self.profileID.utf8))
    }
}

/// A logical session address, not a promise that its transcript has not reset.
/// Callers supply the selected canonical values; no default-agent resolution.
public struct OpenClawNativeSessionRef: Codable, Hashable, Sendable {
    public let owner: OpenClawNativeOwnerRef
    public let agentID: String
    public let sessionKey: String

    public init(owner: OpenClawNativeOwnerRef, agentID: String, sessionKey: String) {
        self.owner = owner
        self.agentID = agentID
        self.sessionKey = sessionKey
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.owner == rhs.owner &&
            lhs.agentID.utf8.elementsEqual(rhs.agentID.utf8) &&
            lhs.sessionKey.utf8.elementsEqual(rhs.sessionKey.utf8)
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(self.owner)
        hasher.combine(Data(self.agentID.utf8))
        hasher.combine(Data(self.sessionKey.utf8))
    }
}

/// The run-to-session association still needs authoritative Gateway evidence.
public struct OpenClawNativeRunRef: Codable, Hashable, Sendable {
    public let session: OpenClawNativeSessionRef
    public let runID: String

    public init(session: OpenClawNativeSessionRef, runID: String) {
        self.session = session
        self.runID = runID
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.session == rhs.session && lhs.runID.utf8.elementsEqual(rhs.runID.utf8)
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(self.session)
        hasher.combine(Data(self.runID.utf8))
    }
}

public enum OpenClawNativeOpenRequest: Equatable, Sendable {
    case session(OpenClawNativeSessionRef)
    case compose(OpenClawNativeSessionRef, draft: String?)
    case liveVoice(OpenClawNativeSessionRef)
    case inspect(OpenClawNativeRunRef)

    public var session: OpenClawNativeSessionRef {
        switch self {
        case let .session(session), let .compose(session, _), let .liveVoice(session):
            session
        case let .inspect(run):
            run.session
        }
    }
}

public enum OpenClawNativeOpenOutcome: Equatable, Sendable {
    case opened
    case cancelled
    case unavailable(reason: String)
}

/// The host owns readiness, authentication, and scene selection. Return opened
/// only after the requested presentation acknowledges that exact target.
@MainActor
public protocol OpenClawNativeActionOpenRouter {
    func open(_ request: OpenClawNativeOpenRequest) async -> OpenClawNativeOpenOutcome
}
