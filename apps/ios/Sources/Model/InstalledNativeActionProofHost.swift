#if DEBUG && OPENCLAW_INSTALLED_NATIVE_ACTION_PROOF
import Foundation
import Observation
import OpenClawKit

/// Observation for the isolated installed proof only. The real router retains
/// all authority; this owner neither wraps submission nor calls a continuation.
@MainActor @Observable
final class InstalledNativeActionProofHost: OpenClawNativeActionHost {
    struct Snapshot: Codable {
        var producers = 0
        var prepared = 0
        var automaticEntries = 0
        var automaticCompletions = 0
        var explicitEntries = 0
        var explicitCompletions = 0
        var kind = "none"
        var automaticOutcome = "none"
        var explicitOutcome = "none"
        var parameterMatch = false
        var runMatch: Bool?
        var misattributed = false
        var idleUnprotectedComposer = false
        var forwardingEntries = 0
        var forwardingCompletions = 0
        var forwardingKind = "none"
        var forwardingOutcome = "none"
        var forwardingOverflow = false
        var forwardingMisattributed = false
    }

    private struct Origin {
        let ordinal: Int
        let id: UUID
        let session: OpenClawNativeSessionRef
        var run: OpenClawNativeRunRef?
    }

    private let router: NativeActionRouter
    private var origin: Origin?
    private(set) var snapshot = Snapshot()

    init(router: NativeActionRouter) {
        self.router = router
    }

    func accessibilityValue(idleUnprotectedComposer: Bool) -> String {
        // Only fixed outcomes, counters and equality facts leave this process.
        // Token, profile, session and run identities remain in the one slot.
        var snapshot = self.snapshot
        snapshot.idleUnprotectedComposer = idleUnprotectedComposer
        guard let data = try? JSONEncoder().encode(snapshot) else { return "invalid" }
        return String(data: data, encoding: .utf8) ?? "invalid"
    }

    func sessions(matching query: String?) async throws -> [OpenClawNativeSessionChoice] {
        try await self.router.sessions(matching: query)
    }

    func runs(matching query: String?) async throws -> [OpenClawNativeRunRef] {
        try await self.router.runs(matching: query)
    }

    private func begin(_ kind: String) -> Int {
        self.snapshot.misattributed = self.snapshot.misattributed ||
            self.snapshot.producers != self.snapshot.prepared ||
            self.snapshot.automaticEntries != self.snapshot.automaticCompletions ||
            self.snapshot.explicitEntries != self.snapshot.explicitCompletions
        self.snapshot.producers += 1
        self.snapshot.kind = kind
        self.snapshot.parameterMatch = false
        self.snapshot.runMatch = nil
        self.snapshot.automaticOutcome = "none"
        self.snapshot.explicitOutcome = "none"
        self.origin = nil
        return self.snapshot.producers
    }

    private func prepared(
        ordinal: Int,
        id: UUID,
        session: OpenClawNativeSessionRef,
        run: OpenClawNativeRunRef? = nil)
    {
        self.snapshot.prepared += 1
        guard ordinal == self.snapshot.producers else {
            self.snapshot.misattributed = true
            return
        }
        self.origin = Origin(ordinal: ordinal, id: id, session: session, run: run)
    }

    func prepareSend(to session: OpenClawNativeSessionRef, message: String) async throws
        -> (send: OpenClawNativePreparedSend, presentationContinuationID: UUID)
    {
        let ordinal = self.begin("send")
        let result = try await self.router.prepareSend(to: session, message: message)
        self.prepared(ordinal: ordinal, id: result.presentationContinuationID, session: result.send.session)
        return result
    }

    func inspect(_ run: OpenClawNativeRunRef) async throws
        -> (inspection: OpenClawNativeRunInspection, presentationContinuationID: UUID)
    {
        let ordinal = self.begin("inspect")
        let result = try await self.router.inspect(run)
        self.prepared(
            ordinal: ordinal,
            id: result.presentationContinuationID,
            session: result.inspection.run.session,
            run: result.inspection.run)
        return result
    }

    func openRun(_ run: OpenClawNativeRunRef, continuing id: UUID) async throws -> OpenClawNativeRunOpenOutcome {
        let ordinal = self.snapshot.producers
        self.snapshot.automaticEntries += 1
        self.snapshot.parameterMatch = self.origin?.ordinal == ordinal &&
            self.origin?.id == id && self.origin?.session == run.session
        if self.snapshot.parameterMatch {
            if let expected = self.origin?.run, expected != run { self.snapshot.misattributed = true }
            self.origin?.run = run
        } else {
            self.snapshot.misattributed = true
        }
        do {
            let result = try await self.router.openRun(run, continuing: id)
            self.snapshot.automaticCompletions += 1
            self.snapshot.misattributed = self.snapshot.misattributed || ordinal != self.snapshot.producers
            self.snapshot.automaticOutcome = result == .opened ? "opened" : "skipped"
            return result
        } catch {
            self.snapshot.automaticCompletions += 1
            self.snapshot.misattributed = self.snapshot.misattributed || ordinal != self.snapshot.producers
            self.snapshot.automaticOutcome = "error"
            throw error
        }
    }

    func open(_ request: OpenClawNativeOpenRequest) async -> OpenClawNativeOpenOutcome {
        self.snapshot.forwardingOverflow = self.snapshot.forwardingOverflow || self.snapshot.forwardingEntries >= 256
        self.snapshot.forwardingMisattributed = self.snapshot.forwardingMisattributed ||
            self.snapshot.forwardingEntries != self.snapshot.forwardingCompletions
        self.snapshot.forwardingEntries = min(256, self.snapshot.forwardingEntries + 1)
        let forwardingOrdinal = self.snapshot.forwardingEntries
        self.snapshot.forwardingKind = switch request {
        case .session: "session"
        case .compose: "compose"
        case .inspect: "inspect"
        }
        guard case let .inspect(run) = request else {
            let result = await self.router.open(request)
            self.forwarded(result, ordinal: forwardingOrdinal)
            return result
        }
        let ordinal = self.snapshot.producers
        self.snapshot.explicitEntries += 1
        self.snapshot.runMatch = self.origin?.run.map { $0 == run }
        let result = await self.router.open(request)
        self.snapshot.explicitCompletions += 1
        self.snapshot.misattributed = self.snapshot.misattributed || ordinal != self.snapshot.producers
        switch result {
        case .opened: self.snapshot.explicitOutcome = "opened"
        case .cancelled: self.snapshot.explicitOutcome = "cancelled"
        case .unavailable: self.snapshot.explicitOutcome = "unavailable"
        }
        self.forwarded(result, ordinal: forwardingOrdinal)
        return result
    }

    private func forwarded(_ result: OpenClawNativeOpenOutcome, ordinal: Int) {
        // This independent counter never changes the Shortcuts producer/continuation slot.
        self.snapshot.forwardingMisattributed = self.snapshot.forwardingMisattributed ||
            ordinal != self.snapshot.forwardingEntries
        self.snapshot.forwardingCompletions = min(256, self.snapshot.forwardingCompletions + 1)
        self.snapshot.forwardingOutcome = switch result {
        case .opened: "opened"
        case .cancelled: "cancelled"
        case .unavailable: "unavailable"
        }
    }
}
#endif
