import Foundation
import OpenClawKit

extension OpenClawChatViewModel {
    struct HistoryRequest {
        var deltaCursor: String?
        var cursorGeneration: UInt64
        var replacingCanonicalHistory: Bool
        var id: UInt64
        var session: SessionSnapshot
        var pendingRunIDs: Set<String>
        var visibleMessagesByID: [UUID: OpenClawChatMessage]
        var historyMutationGeneration: UInt64
        var progressCardGeneration: UInt64
        var runOwnershipGeneration: UInt64
        var latestUserTurn: LatestUserTurn?
    }

    struct RunHistoryRefreshResult {
        let applied: Bool
        let runSnapshotApplied: Bool
        let supportsInFlightRunState: Bool
        let hasInFlightRun: Bool
        let sessionHasActiveRun: Bool
        var retryAfterMs: Int?
        var errorDescription: String?
        var cancelled = false

        static let failed = RunHistoryRefreshResult(
            applied: false,
            runSnapshotApplied: false,
            supportsInFlightRunState: false,
            hasInFlightRun: false,
            sessionHasActiveRun: false)
    }

    struct LatestUserTurn: Equatable {
        var idempotencyKey: String?
        var refreshKey: String?
        var occurrence: Int
        var timestamp: Double?
    }

    func invalidateHistoryAfterTransportEvent(_ evt: OpenClawChatTransportEvent) {
        // Route recovery retires run ownership, not an unconfirmed submitted bubble.
        let localUserEchoIDs = self.historyRouteLocalUserEchoIDs
            .union(self.pendingLocalUserEchoMessageIDsByRunID.values)
        self.invalidateHistorySnapshots(after: evt)
        if case .routeChanged = evt { self.historyRouteLocalUserEchoIDs = localUserEchoIDs }
    }

    @discardableResult
    func refreshHistoryAfterRun(
        historyRequest request: HistoryRequest? = nil,
        requireCurrentInvalidation: Bool = false) async
        -> RunHistoryRefreshResult
    {
        guard !self.usesWebConversation else { return .failed }
        let request = request ?? self.beginHistoryRequest()
        return await self.refreshHistory(
            request: request,
            policy: HistoryRefreshPolicy(),
            requireCurrentInvalidation: requireCurrentInvalidation)
    }

    /// The transaction owns both the wire read and its single publication. Sharing only a raw
    /// response makes every follower retry when the first consumer advances the accepted cursor.
    func refreshHistory(
        request original: HistoryRequest,
        policy: HistoryRefreshPolicy,
        requireCurrentInvalidation: Bool = false,
        canonicalRead: (@MainActor @Sendable () async throws
            -> (payload: OpenClawChatHistoryPayload, messages: [OpenClawChatMessage]))? = nil) async
        -> RunHistoryRefreshResult
    {
        var request = original
        while !Task.isCancelled, !self.isTransportDetached, self.isCurrentSession(original.session),
              original.cursorGeneration == self.historyCursorGeneration
        {
            guard !requireCurrentInvalidation || self.canRefreshInvalidatedHistory(original) else { return .failed }
            // A fast successor may finish before all waiters resume. Its admission ID lets
            // those existing callers share it without caching a later, independent refresh.
            if let completed = self.completedHistoryRefresh, completed.result.applied,
               completed.request.id >= original.id,
               self.canShareHistoryRefresh(completed.request, with: original), completed.policy == policy
            {
                return self.historyRefreshResult(completed.result, for: original)
            }
            if let active = self.historyRefresh {
                let sameRead = self.canShareHistoryRefresh(active.request, with: request) && active.policy == policy
                let result = await active.task.value
                guard !Task.isCancelled, !self.isTransportDetached, self.isCurrentSession(original.session),
                      original.cursorGeneration == self.historyCursorGeneration else { return .failed }
                guard !requireCurrentInvalidation || self.canRefreshInvalidatedHistory(original) else {
                    return .failed
                }
                if sameRead {
                    return self.historyRefreshResult(result, for: original)
                }
                // All invalidations observed during a read wait here. The first current waiter
                // admits the successor; equivalent waiters join it with its newly accepted cursor.
                request = self.beginHistoryRequest(
                    for: original.session,
                    captureLatestUserTurn: original.latestUserTurn != nil)
                continue
            }
            // A current caller may arrive after a newer, incompatible refresh has published.
            // Admit its wire read against the current request order and transcript, even when
            // that refresh left the visible rows unchanged. Session/route guards remain above.
            if request.id < max(self.latestAppliedHistoryRequestID, self.latestAppliedHistoryCursorRequestID) ||
                self.messages.count != request.visibleMessagesByID.count ||
                self.messages.contains(where: { request.visibleMessagesByID[$0.id] != $0 })
            {
                request = self.beginHistoryRequest(
                    for: original.session,
                    captureLatestUserTurn: original.latestUserTurn != nil)
            }
            let admitted = request
            let task = Task { [weak self] in
                guard let self else { return RunHistoryRefreshResult.failed }
                defer {
                    if self.historyRefresh?.request.id == admitted.id {
                        self.historyRefresh = nil
                    }
                }
                let result = await self.performHistoryRefresh(
                    request: admitted,
                    policy: policy,
                    invalidationRequest: requireCurrentInvalidation ? original : nil,
                    canonicalRead: canonicalRead)
                if self.historyRefresh?.request.id == admitted.id {
                    self.completedHistoryRefresh = (admitted, policy, result)
                }
                return result
            }
            self.historyRefresh = (admitted, policy, task)
            let result = await task.value
            guard !Task.isCancelled, !self.isTransportDetached, self.isCurrentSession(original.session),
                  original.cursorGeneration == self.historyCursorGeneration else { return .failed }
            return self.historyRefreshResult(result, for: original)
        }
        return .failed
    }

    private func canShareHistoryRefresh(_ lhs: HistoryRequest, with rhs: HistoryRequest) -> Bool {
        lhs.session == rhs.session && lhs.cursorGeneration == rhs.cursorGeneration &&
            lhs.historyMutationGeneration == rhs.historyMutationGeneration &&
            lhs.runOwnershipGeneration == rhs.runOwnershipGeneration &&
            lhs.progressCardGeneration == rhs.progressCardGeneration && lhs.latestUserTurn == rhs.latestUserTurn
    }

    private func historyRefreshResult(
        _ result: RunHistoryRefreshResult,
        for request: HistoryRequest) -> RunHistoryRefreshResult
    {
        RunHistoryRefreshResult(
            applied: result.applied,
            runSnapshotApplied: result.runSnapshotApplied &&
                request.runOwnershipGeneration == self.runOwnershipGeneration,
            supportsInFlightRunState: result.supportsInFlightRunState,
            hasInFlightRun: result.hasInFlightRun,
            sessionHasActiveRun: result.sessionHasActiveRun,
            retryAfterMs: result.retryAfterMs,
            errorDescription: result.errorDescription,
            cancelled: result.cancelled)
    }

    private struct LoadedHistory {
        let request: HistoryRequest
        let payload: OpenClawChatHistoryPayload
        let messages: [OpenClawChatMessage]?
        let replacingCanonicalHistory: Bool
    }

    private func loadStableHistory(
        request initial: HistoryRequest,
        canonicalRead: (@MainActor @Sendable () async throws
            -> (payload: OpenClawChatHistoryPayload, messages: [OpenClawChatMessage]))?) async throws
        -> LoadedHistory?
    {
        var request = initial
        var payload: OpenClawChatHistoryPayload
        var replacingCanonicalHistory: Bool
        var decodedMessages: [OpenClawChatMessage]?
        while true {
            guard !Task.isCancelled, !self.isTransportDetached,
                  self.canApplyHistory(request) else { return nil }
            request.deltaCursor = self.historyDeltaCursor
            var malformedCursorPayload = false
            decodedMessages = nil
            if let canonicalRead {
                let canonical = try await canonicalRead()
                payload = canonical.payload
                decodedMessages = canonical.messages
            } else if let cursor = request.deltaCursor {
                do {
                    payload = try await transport.requestHistory(sessionKey: request.session.key, cursor: cursor)
                } catch is DecodingError {
                    guard self.canApplyHistory(request) else { return nil }
                    if request.deltaCursor != self.historyDeltaCursor { continue }
                    payload = try await transport.requestHistory(sessionKey: request.session.key)
                    malformedCursorPayload = true
                }
            } else {
                payload = try await transport.requestHistory(sessionKey: request.session.key)
            }
            guard self.canApplyHistory(request) else { return nil }
            // Request IDs order callers, not server projections. Retry from the accepted cursor
            // rather than treating a response from an overlapping cursor read as a newer tip.
            if request.deltaCursor != self.historyDeltaCursor { continue }
            if payload.kind == "delta" {
                decodedMessages = await Self.decodeHistoryDelta(payload)
            }
            guard !Task.isCancelled, !self.isTransportDetached,
                  self.canApplyHistory(request) else { return nil }
            if request.deltaCursor != self.historyDeltaCursor { continue }
            replacingCanonicalHistory = malformedCursorPayload || request.replacingCanonicalHistory ||
                payload.kind == "reset" ||
                (payload.kind == "delta" && decodedMessages == nil)
            if payload.kind == "reset" || payload.kind == "delta" && replacingCanonicalHistory {
                decodedMessages = nil
                if let canonicalRead {
                    let canonical = try await canonicalRead()
                    payload = canonical.payload
                    decodedMessages = canonical.messages
                } else {
                    payload = try await transport.requestHistory(sessionKey: request.session.key)
                }
                guard self.canApplyHistory(request) else { return nil }
                if request.deltaCursor != self.historyDeltaCursor { continue }
            }
            if decodedMessages == nil {
                decodedMessages = if payload.kind == "delta" {
                    await Self.decodeHistoryDelta(payload)
                } else {
                    await Self.decodeMessages(payload.messages ?? [], activity: payload.activity)
                }
            }
            guard !Task.isCancelled, !self.isTransportDetached,
                  self.canApplyHistory(request) else { return nil }
            // Decoding can overlap live events and another accepted cursor just like the wire read.
            if request.deltaCursor != self.historyDeltaCursor { continue }
            return LoadedHistory(
                request: request,
                payload: payload,
                messages: decodedMessages,
                replacingCanonicalHistory: replacingCanonicalHistory)
        }
    }

    private func performHistoryRefresh(
        request initial: HistoryRequest,
        policy: HistoryRefreshPolicy,
        invalidationRequest: HistoryRequest?,
        canonicalRead: (@MainActor @Sendable () async throws
            -> (payload: OpenClawChatHistoryPayload, messages: [OpenClawChatMessage]))?) async
        -> RunHistoryRefreshResult
    {
        do {
            guard let history = try await self.loadStableHistory(
                request: initial,
                canonicalRead: canonicalRead) else { return .failed }
            let request = history.request
            let payload = history.payload
            guard !Task.isCancelled, !self.isTransportDetached else { return .failed }
            if let invalidationRequest, !self.canRefreshInvalidatedHistory(invalidationRequest) {
                return .failed
            }
            let runSnapshotApplied = request.runOwnershipGeneration == self.runOwnershipGeneration &&
                request.id >= self.latestAppliedRunSnapshotRequestID
            let applied = self.applyHistoryPayload(
                payload,
                for: request,
                preservingOptimisticLocalMessages: policy.preservingOptimisticLocalMessages,
                replacingCanonicalHistory: history.replacingCanonicalHistory,
                syncThinkingOptions: policy.syncThinkingOptions,
                decodedMessages: history.messages)
            let hasInFlightRun = ChatPayloadDecoding.trimmedNonEmptyString(payload.inFlightRun?.runId) != nil
            let sessionHasActiveRun = payload.sessionInfo?.hasActiveRun == true
            // `hasActiveRun` is session-wide and can be true for an embedded agent run.
            // Its presence capability-gates an authoritative missing chat snapshot, but
            // only `inFlightRun` establishes ownership of the pending chat run.
            let supportsInFlightRunState = hasInFlightRun || payload.sessionInfo?.hasActiveRun != nil
            return RunHistoryRefreshResult(
                applied: applied,
                runSnapshotApplied: applied && runSnapshotApplied,
                supportsInFlightRunState: supportsInFlightRunState,
                hasInFlightRun: hasInFlightRun,
                sessionHasActiveRun: sessionHasActiveRun)
        } catch {
            chatUILogger.error("refresh history failed \(error.localizedDescription, privacy: .public)")
            var failure = RunHistoryRefreshResult.failed
            failure.errorDescription = error.localizedDescription
            failure.cancelled = error is CancellationError
            if let response = error as? GatewayResponseError,
               response.method == "chat.history", response.code == "UNAVAILABLE",
               response.details["retryable"]?.boolValue == true
            {
                failure.retryAfterMs = max(0, response.details["retryAfterMs"]?.intValue ?? 250)
            }
            return failure
        }
    }
}
