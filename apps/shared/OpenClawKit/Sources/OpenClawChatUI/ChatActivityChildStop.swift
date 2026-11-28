import Foundation
import OpenClawKit
import OpenClawProtocol

/// Prefer the displayed turn. A live or yielded child without a published run ID is stopped by session.
public struct OpenClawChildStopTarget: Equatable, Sendable {
    public let key: String
    public let agentID: String?
    public let sessionID: String?
    public let runID: String?
    private let scopedWriterOwnsRow: Bool

    public init?(_ row: OpenClawChatSessionEntry) {
        guard !ChatActivityChild.state(of: row).isFinished else { return nil }
        let ids = row.activeRunIds ?? []
        let agentID = row.agentId ?? OpenClawChatSessionKey.agentID(from: row.key)
        if ids.isEmpty {
            // sessions.list can omit IDs even on a live child. Only offer the session operation for
            // a positively identified obligation, not merely because an unknown row is in Running.
            guard row.subagentRunState == "active" || row.subagentRunState == "paused" || row
                .hasActiveSubagentRun == true,
                agentID?.trimmedNonEmpty != nil, row.sessionId?.trimmedNonEmpty != nil else { return nil }
            self.runID = nil
        } else {
            guard ids.count == 1, let id = ids[0].trimmedNonEmpty else { return nil }
            self.runID = id
        }
        self.key = row.key
        self.agentID = agentID
        self.sessionID = row.sessionId
        self.scopedWriterOwnsRow = row.sharingRole == .owner || row.sharingRole == .admin
    }

    public func allows(scopes: Set<String>) -> Bool {
        scopes.contains("operator.admin") || scopes.contains("operator.write") ||
            (scopes.contains("operator.sessions.write") && self.scopedWriterOwnsRow)
    }

    public static let method = "sessions.abort"
    public var request: OpenClawChatGatewayRequest {
        var params = ["key": AnyCodable(self.key)]
        if let runID { params["runId"] = AnyCodable(runID) }
        if let agentID { params["agentId"] = AnyCodable(agentID) }
        return OpenClawChatGatewayRequest(method: Self.method, params: params, timeoutMs: 15000)
    }
}

/// Acquire the operation on the connection that advertised it. A changed route cannot receive the old tap.
public protocol OpenClawChildStopTransport: OpenClawChatTransport {
    func prepareChildStop(_ target: OpenClawChildStopTarget) async -> OpenClawChildStopAction?
}

public struct OpenClawChildStopAction: Sendable {
    public let target: OpenClawChildStopTarget
    public let send: @Sendable () async throws -> Data

    public init(target: OpenClawChildStopTarget, send: @escaping @Sendable () async throws -> Data) {
        self.target = target
        self.send = send
    }

    public struct Receipt: Decodable {
        public enum Status: String, Decodable { case aborted
            case noActiveRun = "no-active-run"
        }

        public let ok: Bool
        public let status: Status
        public let warning: String?
    }

    func perform() async throws -> Receipt {
        let receipt = try await JSONDecoder().decode(Receipt.self, from: self.send())
        guard receipt.ok else { throw CocoaError(.coderReadCorrupt) }
        return receipt
    }
}

extension OpenClawChatViewModel {
    /// Re-read the operator's roster on success, no-active-run, or a lost reply. It owns the terminal state.
    func stopActivityChild(_ action: OpenClawChildStopAction, current: OpenClawChatSessionEntry) async throws
        -> OpenClawChildStopAction.Receipt
    {
        guard OpenClawChildStopTarget(current) == action.target, self.healthOK else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let parent = self.currentSessionSnapshot()
        do {
            let receipt = try await action.perform()
            await self.fetchSessions(limit: Self.sessionListFetchLimit, sessionSnapshot: parent)
            return receipt
        } catch {
            await self.fetchSessions(limit: Self.sessionListFetchLimit, sessionSnapshot: parent)
            throw error
        }
    }
}
