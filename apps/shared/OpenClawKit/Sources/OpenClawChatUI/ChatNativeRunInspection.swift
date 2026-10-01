import Foundation
import OpenClawNativeActions

/// A bounded projection, not a scheduler. Receipts establish input ownership;
/// only an exact active/terminal run fact establishes execution state.
public enum OpenClawChatNativeRunInspection {
    public static func reduce(
        _ history: OpenClawChatHistoryPayload,
        run: OpenClawNativeRunRef) throws -> OpenClawNativeRunInspection
    {
        try self.requireSession(history, session: run.session)
        let info = history.sessionInfo
        let active = info?.activeRunIds?.contains { $0.utf8.elementsEqual(run.runID.utf8) } == true
        let lastRunMatches = info?.lastRunId?.utf8.elementsEqual(run.runID.utf8) == true
        let outcome = !active && lastRunMatches
            ? info?.status.flatMap(OpenClawNativeRunInspection.Outcome.init(rawValue:))
            : nil
        let receipt = history.inputReceipts?.contains {
            $0.runId.utf8.elementsEqual(run.runID.utf8) && ["pending", "consumed"].contains($0.state)
        } == true
        let reply = OpenClawChatHistoryPresentation.replyText(
            from: history.messages ?? [],
            runID: run.runID,
            inputConsumptions: history.inputConsumptions)
        return OpenClawNativeRunInspection(
            run: run,
            association: active || lastRunMatches || receipt || reply != nil ? .observed : .notObserved,
            activity: active ? .active : .unknown,
            outcome: outcome,
            reply: reply,
            error: outcome != nil && outcome != .done ? info?.lastRunError : nil)
    }

    public static func requireSession(
        _ history: OpenClawChatHistoryPayload,
        session: OpenClawNativeSessionRef) throws
    {
        // history.sessionKey echoes the request. Only sessionInfo identifies
        // the Gateway's resolved owner, including global/default alias routing.
        guard history.sessionInfo?.key?.utf8.elementsEqual(session.sessionKey.utf8) == true,
              history.sessionInfo?.agentId?.utf8.elementsEqual(session.agentID.utf8) == true
        else {
            throw OpenClawNativeActionError("The selected session could not be verified. Select it again in OpenClaw.")
        }
    }
}

/// Platform adapters provide an already captured physical connection. Queries
/// and sends never create a connection or discover a replacement through here.
public struct OpenClawChatNativeActionGateway: Sendable {
    public let gatewayID: String
    public let gatewayName: String
    private let supportsProfileBinding: @Sendable () async -> Bool
    private let request: @Sendable (OpenClawChatGatewayRequest, String?) async throws -> Data
    public let isCurrent: @Sendable () async -> Bool

    public init(
        gatewayID: String,
        gatewayName: String,
        supportsProfileBinding: @escaping @Sendable () async -> Bool,
        request: @escaping @Sendable (OpenClawChatGatewayRequest, String?) async throws -> Data,
        isCurrent: @escaping @Sendable () async -> Bool)
    {
        self.gatewayID = gatewayID
        self.gatewayName = gatewayName
        self.supportsProfileBinding = supportsProfileBinding
        self.request = request
        self.isCurrent = isCurrent
    }

    public func owner(expected: OpenClawNativeOwnerRef? = nil) async throws -> OpenClawNativeOwnerRef {
        struct Response: Decodable {
            struct Profile: Decodable { let id: String }
            let profile: Profile
        }
        guard await self.isCurrent() else { throw CancellationError() }
        let supportsProfileBinding = await self.supportsProfileBinding()
        guard await self.isCurrent() else { throw CancellationError() }
        guard supportsProfileBinding else {
            throw OpenClawNativeActionError(
                "Update the selected Gateway to use account-bound native actions.")
        }
        let data = try await self.request(
            .init(method: "users.self", params: [:], timeoutMs: 10000),
            expected?.profileID)
        let profile = try JSONDecoder().decode(Response.self, from: data).profile
        let owner = OpenClawNativeOwnerRef(gatewayID: self.gatewayID, profileID: profile.id)
        guard !profile.id.isEmpty, await self.isCurrent(), expected == nil || expected == owner else {
            throw OpenClawNativeActionError("The selected account changed. Select the session again.")
        }
        return owner
    }

    public func sessions(matching query: String?) async throws -> [OpenClawNativeSessionChoice] {
        let (owner, entries) = try await self.sessionEntries(matching: query)
        return entries.compactMap { entry in
            guard let session = self.session(entry, owner: owner) else { return nil }
            return OpenClawNativeSessionChoice(
                session: session,
                title: entry.displayName ?? entry.derivedTitle ?? entry.label ?? entry.key,
                gatewayName: self.gatewayName)
        }
    }

    private func sessionEntries(
        matching query: String?) async throws -> (OpenClawNativeOwnerRef, [OpenClawChatSessionEntry])
    {
        let owner = try await self.owner()
        let data = try await self.request(
            OpenClawChatGatewayRequests.sessionsList(limit: 50, search: query, archived: false),
            owner.profileID)
        let response = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        guard await self.isCurrent() else { throw CancellationError() }
        return (owner, Array(response.sessions.prefix(50)))
    }

    private func session(
        _ entry: OpenClawChatSessionEntry,
        owner: OpenClawNativeOwnerRef) -> OpenClawNativeSessionRef?
    {
        guard let agent = entry.agentId, !agent.isEmpty, !entry.key.isEmpty else { return nil }
        return .init(owner: owner, agentID: agent, sessionKey: entry.key)
    }

    public func history(
        session: OpenClawNativeSessionRef,
        runID: String? = nil) async throws -> OpenClawChatHistoryPayload
    {
        _ = try await self.owner(expected: session.owner)
        let data = try await self.request(
            OpenClawChatGatewayRequests.history(
                sessionKey: session.sessionKey,
                agentID: session.agentID,
                limit: 100,
                maxChars: 2000,
                inputRunIDs: runID.map { [$0] },
                timeoutMs: 10000),
            session.owner.profileID)
        let history = try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: data)
        guard await self.isCurrent() else { throw CancellationError() }
        try OpenClawChatNativeRunInspection.requireSession(history, session: session)
        return history
    }

    public func runs(matching query: String?) async throws -> [OpenClawNativeRunRef] {
        let (owner, entries) = try await self.sessionEntries(matching: nil)
        var runs: [OpenClawNativeRunRef] = []
        for entry in entries {
            guard let session = self.session(entry, owner: owner) else { continue }
            let ids = (entry.activeRunIds ?? []) + [entry.lastRunId].compactMap(\.self)
            for id in ids.prefix(10) where !id.isEmpty {
                let run = OpenClawNativeRunRef(session: session, runID: id)
                if !runs.contains(run), query.map({ id.localizedCaseInsensitiveContains($0) }) ?? true {
                    runs.append(run)
                    if runs.count == 50 { return runs }
                }
            }
        }
        return runs
    }

    @MainActor
    public func prepareSubmission(
        viewModel: OpenClawChatViewModel,
        session: OpenClawNativeSessionRef,
        message: String,
        lease: OpenClawChatTransportRouteLease,
        presentationIsCurrent: @escaping @MainActor @Sendable () -> Bool) async throws -> OpenClawNativePreparedSend
    {
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw OpenClawNativeActionError("Enter a message to send.")
        }
        _ = try await self.owner(expected: session.owner)
        guard presentationIsCurrent(), viewModel.hasAppliedLiveHistory, !viewModel.isLoading, viewModel.healthOK else {
            throw OpenClawNativeActionError("The selected chat is not ready. Open it and try again.")
        }
        let invocation = OpenClawChatExternalSubmission(target: session, message: message)
        let route = OpenClawChatExternalSubmissionRoute(target: session, lease: lease) {
            guard await self.isCurrent() else { return false }
            return await presentationIsCurrent()
        }
        return OpenClawNativePreparedSend(session: session) {
            // Confirmation can outlive the connection, account, or visible chat.
            // Revalidate the captured owner; never acquire a successor lease.
            _ = try await self.owner(expected: session.owner)
            guard presentationIsCurrent() else {
                throw OpenClawNativeActionError("The selected chat changed. Nothing was sent.")
            }
            switch await viewModel.submit(invocation, using: route) {
            case let .accepted(runID):
                return OpenClawNativeRunRef(session: session, runID: runID)
            case .queued:
                throw OpenClawNativeActionError(
                    "The message was not sent live. Check the selected chat before retrying.")
            case let .rejected(reason), let .notDispatched(reason), let .uncertain(reason):
                throw OpenClawNativeActionError(reason)
            case .cancelled:
                throw CancellationError()
            }
        }
    }
}
