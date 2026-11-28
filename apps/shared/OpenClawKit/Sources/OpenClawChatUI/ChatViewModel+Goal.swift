import Foundation
import OpenClawKit
import OpenClawProtocol

public struct OpenClawChatGoalMutation: Sendable {
    public enum Action: Equatable, Sendable {
        case pause
        case resume
        case edit(String)
        case clear

        public var name: String {
            switch self {
            case .pause: "pause"
            case .resume: "resume"
            case .edit: "edit"
            case .clear: "clear"
            }
        }
    }

    public let action: Action
    public let sessionKey: String
    public let agentID: String?
    public let sessionID: String
    public let goalID: String
    public let operationID = UUID().uuidString
    private let issuedAtMs = Int64(Date().timeIntervalSince1970 * 1000)

    public var request: OpenClawChatGatewayRequest {
        var params: [String: AnyCodable] = [
            "sessionKey": AnyCodable(self.sessionKey), "sessionId": AnyCodable(self.sessionID),
            "goalId": AnyCodable(self.goalID), "operationId": AnyCodable(self.operationID),
            "issuedAtMs": AnyCodable(self.issuedAtMs),
        ]
        if let agentID { params["agentId"] = AnyCodable(agentID) }
        if self.action != .clear { params["action"] = AnyCodable(self.action.name) }
        if case let .edit(objective) = self.action { params["objective"] = AnyCodable(objective) }
        return OpenClawChatGatewayRequest(
            method: self.action == .clear ? "sessions.goal.clear" : "sessions.goal.update",
            params: params,
            timeoutMs: 30000)
    }
}

public protocol OpenClawChatGoalTransport: OpenClawChatTransport {
    func goalControls() async -> (update: Bool, clear: Bool)
    func mutateGoal(_ mutation: OpenClawChatGoalMutation) async throws -> Data
}

extension OpenClawChatViewModel {
    var canManageGoal: Bool {
        self.transport is any OpenClawChatGoalTransport && self.healthOK && self.sessionId != nil
    }

    func goalOperationLabel(for goal: OpenClawChatSessionGoal) -> String? {
        guard let operation = self.goalActivity.operation, operation.goalID == goal.id,
              operation.sessionID == self.sessionId, operation.action == .resume else { return nil }
        return self
            .goalActivity.pending ? String(localized: "Resuming goal…") : String(localized: "Goal resume unconfirmed")
    }

    /// The session row owns the confirmed state. Never leave an optimistic edit or deletion in it on failure.
    /// If the response was lost, Check update explicitly reuses the same request (including its timestamp).
    func applyGoalAction(_ action: OpenClawChatGoalMutation.Action, to goalID: String) async throws {
        let session = self.currentSessionSnapshot()
        let connection = self.sessionMetadataGeneration
        guard self.canManageGoal, !self.goalActivity.pending,
              let transport = self.transport as? any OpenClawChatGoalTransport,
              let row = self.currentSessionEntry(), let sessionID = self.sessionId,
              row.goal?.id == goalID, row.sessionId == nil || row.sessionId == sessionID
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let operation: OpenClawChatGoalMutation
        if let existing = self.goalActivity.operation, existing.goalID == goalID, existing.sessionID == sessionID {
            guard existing.action == action else { throw OpenClawChatTransportSendError.notDispatched }
            operation = existing
        } else {
            operation = OpenClawChatGoalMutation(
                action: action,
                sessionKey: row.key,
                agentID: session.deliveryAgentID,
                sessionID: sessionID,
                goalID: goalID)
        }
        self.goalActivity.operation = operation
        self.goalActivity.pending = true
        defer {
            if self.goalActivity.operation?.operationID == operation.operationID || self.goalActivity.operation == nil {
                self.goalActivity.pending = false
            }
        }
        do {
            let data = try await transport.mutateGoal(operation)
            let receipt = try JSONDecoder().decode(SessionsGoalMutationResult.self, from: data)
            let goal = try receipt.goal.map { fields in
                try JSONDecoder().decode(OpenClawChatSessionGoal.self, from: JSONEncoder().encode(fields))
            }
            let status = receipt.status.stringValue
            let matchesGoal = action == .clear ? status == "cleared" : goal?.id == goalID && goal?.isPresentable == true
            guard receipt.operationid == operation.operationID, receipt.goalid == goalID,
                  receipt.sessionid == sessionID, receipt.action.stringValue == action.name,
                  matchesGoal
            else {
                throw URLError(.badServerResponse)
            }
            guard self.isCurrentSession(session), self.sessionId == sessionID,
                  self.healthOK, connection == self.sessionMetadataGeneration else { throw CancellationError() }
            self.goalActivity.operation = nil
            if receipt.replayed == true {
                // An old receipt describes that decision, not the live goal or a still-running reply.
                await self.fetchSessions(limit: Self.sessionListFetchLimit, sessionSnapshot: session)
                return
            }
            guard let index = self.sessions.firstIndex(where: { $0.key == row.key }),
                  let current = self.sessions[index].goal, current.id == goalID else { return }
            if let updatedAt = goal?.updatedAt, updatedAt < (current.updatedAt ?? 0) { return }
            self.sessions[index].goal = goal
            if status == "started", let runID = receipt.runid {
                self.adoptRun(
                    runId: runID,
                    bufferedText: self.pendingRuns.contains(runID) ? (self.streamingAssistantText ?? "") : "")
            }
        } catch {
            if self.goalActivity.operation?.operationID == operation.operationID {
                if error is GatewayNodeSessionRequestError || error is OpenClawChatTransportSendError ||
                    (error as? GatewayResponseError).map({ $0.code != "UNAVAILABLE" }) == true
                {
                    self.goalActivity.operation = nil
                }
                if self.isCurrentSession(session) { self.refreshSessions() }
            }
            throw error
        }
    }
}
