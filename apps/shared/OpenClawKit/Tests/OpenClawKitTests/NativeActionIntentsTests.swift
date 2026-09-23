#if os(iOS) || os(macOS)
import Foundation
import Testing
@testable import OpenClawKit

struct NativeActionIntentsTests {
    #if os(macOS)
    @Test func `session intents preserve the selected operation and draft`() async {
        // The production host install is process-wide; isolate it from other suites.
        await #expect(processExitsWith: .success) {
            try await NativeActionIntentsTests.checkSessionOperations()
        }
    }

    @Test func `automatic run opening never falls back to a fresh explicit action`() async {
        await #expect(processExitsWith: .success) {
            try await NativeActionIntentsTests.checkRunContinuationParameters()
        }
    }

    @MainActor
    private static func checkRunContinuationParameters() async throws {
        let run = OpenClawNativeRunRef(
            session: .init(
                owner: .init(gatewayID: "gateway-a", profileID: "alice"),
                agentID: "main",
                sessionKey: "global"),
            runID: "accepted-run")
        let target = try OpenClawRunEntity(run: run)
        let host = ObservingNativeActionHost()
        OpenClawNativeActionServices.install(host: host)
        let explicit = OpenRunIntent(target: target)
        try #require(explicit.automatic == false && explicit.presentationID == nil)
        _ = try await explicit.perform()
        try #require(host.requests == [.inspect(run)])
        var omittedAutomatic = OpenRunIntent(target: target)
        omittedAutomatic.automatic = nil
        try #require(omittedAutomatic.presentationID == nil)
        _ = try await omittedAutomatic.perform()
        try #require(host.requests == [.inspect(run), .inspect(run)])
        try #require(host.continuations.isEmpty)

        let id = UUID()
        let automatic = OpenRunIntent(target: target, continuing: id)
        try #require(automatic.automatic == true && automatic.presentationID == id.uuidString)
        // Reconstruct only real parameters, as a fresh framework consumer would.
        // Actual Shortcuts serialization and hidden editor fields need installed proof.
        var reconstructed = OpenRunIntent()
        reconstructed.target = target
        reconstructed.automatic = automatic.automatic
        reconstructed.presentationID = automatic.presentationID
        _ = try await reconstructed.perform()
        try #require(host.continuations.count == 1)
        try #require(host.continuations[0].0 == run && host.continuations[0].1 == id)
        host.continuationOutcome = .skipped
        _ = try await reconstructed.perform()
        try #require(host.continuations.count == 2)

        let malformedIDs: [String?] = [nil, "", "not-a-uuid"]
        for value in malformedIDs {
            reconstructed.presentationID = value
            _ = try await reconstructed.perform()
        }
        try #require(host.continuations.count == 2)
        let nonAutomaticValues: [Bool?] = [false, nil]
        for automaticValue in nonAutomaticValues {
            reconstructed.automatic = automaticValue
            for value in ["", "not-a-uuid", id.uuidString] {
                reconstructed.presentationID = value
                await #expect(throws: OpenClawNativeActionError.self) { _ = try await reconstructed.perform() }
                try #require(host.requests == [.inspect(run), .inspect(run)])
                try #require(host.continuations.count == 2)
            }
        }

        host.failContinuation = true
        await #expect(throws: OpenClawNativeActionError.self) { _ = try await automatic.perform() }
        let cancelled = Task { try await automatic.perform() }
        cancelled.cancel()
        await #expect(throws: CancellationError.self) { _ = try await cancelled.value }
        try #require(host.continuations.count == 3)
        let resolved = try await OpenClawRunQuery().entities(for: [target.id])
        try #require(resolved.map(\.run) == [run])
    }

    @MainActor
    private static func checkSessionOperations() async throws {
        let session = OpenClawNativeSessionRef(
            owner: .init(gatewayID: "gateway-e\u{301}", profileID: "profile-a"),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main")
        let target = try OpenClawSessionEntity(session: session)
        let draft = "  Draft e\u{301}\n"
        let host = ObservingNativeActionHost()
        OpenClawNativeActionServices.install(host: host)

        var defaultOpen = OpenSessionIntent()
        defaultOpen.target = target
        defaultOpen.draft = draft
        _ = try await defaultOpen.perform()
        _ = try await OpenSessionIntent(target: target, draft: draft).perform()
        var omittedOperation = OpenSessionIntent()
        omittedOperation.target = target
        omittedOperation.operation = nil
        omittedOperation.draft = draft
        _ = try await omittedOperation.perform()
        try #require(host.requests == [.session(session), .session(session), .session(session)])

        _ = try await OpenSessionIntent(target: target, operation: .compose, draft: draft).perform()
        var compose = OpenComposeIntent()
        compose.target = target
        compose.draft = draft
        _ = try await compose.perform()
        try #require(host.requests.count == 5)
        for request in host.requests.suffix(2) {
            guard case let .compose(selected, receivedDraft) = request else {
                throw OpenClawNativeActionError("Expected a compose request.")
            }
            try #require(selected == session)
            let received = try #require(receivedDraft)
            try #require(received.utf8.elementsEqual(draft.utf8))
        }
    }
    #endif

    @Test func `saved entity selectors preserve exact spelling`() async throws {
        let first = OpenClawNativeSessionRef(
            owner: .init(gatewayID: "gateway-e\u{301}", profileID: "profile-a"),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main")
        let second = OpenClawNativeSessionRef(
            owner: .init(gatewayID: "gateway-\u{E9}", profileID: "profile-a"),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main")
        let entities = try [OpenClawSessionEntity(session: first), OpenClawSessionEntity(session: second)]
        #expect(entities[0].id != entities[1].id)
        let resolved = try await OpenClawSessionQuery().entities(for: entities.map(\.id))
        #expect(resolved.map(\.session) == [first, second])
    }

    @Test func `unprofiled selections cannot become entities`() {
        let session = OpenClawNativeSessionRef(
            owner: .init(gatewayID: "gateway-a", profileID: ""),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main")
        #expect(throws: OpenClawNativeActionError.self) { try OpenClawSessionEntity(session: session) }
        #expect(throws: OpenClawNativeActionError.self) {
            try OpenClawRunEntity(run: .init(session: session, runID: "run-a"))
        }
    }
}

#if os(macOS)
@MainActor
private final class ObservingNativeActionHost: OpenClawNativeActionHost {
    var requests: [OpenClawNativeOpenRequest] = []
    var continuations: [(OpenClawNativeRunRef, UUID)] = []
    var continuationOutcome = OpenClawNativeRunOpenOutcome.opened
    var failContinuation = false

    func openRun(_ run: OpenClawNativeRunRef, continuing id: UUID) async throws -> OpenClawNativeRunOpenOutcome {
        self.continuations.append((run, id))
        if self.failContinuation { throw OpenClawNativeActionError("The selected Gateway refused this read.") }
        return self.continuationOutcome
    }

    func open(_ request: OpenClawNativeOpenRequest) async -> OpenClawNativeOpenOutcome {
        self.requests.append(request)
        return .opened
    }

    func sessions(matching query: String?) async throws -> [OpenClawNativeSessionChoice] {
        throw OpenClawNativeActionError("Opening a selected session must not query the catalog.")
    }

    func runs(matching query: String?) async throws -> [OpenClawNativeRunRef] {
        throw OpenClawNativeActionError("Opening a selected session must not query runs.")
    }

    func prepareSend(
        to session: OpenClawNativeSessionRef,
        message: String) async throws -> (send: OpenClawNativePreparedSend, presentationContinuationID: UUID)
    {
        throw OpenClawNativeActionError("Opening or composing must not submit a message.")
    }

    func inspect(_ run: OpenClawNativeRunRef) async throws
        -> (inspection: OpenClawNativeRunInspection, presentationContinuationID: UUID)
    {
        throw OpenClawNativeActionError("Opening or composing must not inspect a run.")
    }
}
#endif
#endif
