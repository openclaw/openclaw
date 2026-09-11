#if os(iOS) || os(macOS)
import OpenClawKit
import Testing

struct NativeActionIntentsTests {
    #if os(macOS)
    @Test func `session intents preserve the selected operation and draft`() async {
        // The production host install is process-wide; isolate it from other suites.
        await #expect(processExitsWith: .success) {
            try await NativeActionIntentsTests.checkSessionOperations()
        }
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
        message: String) async throws -> OpenClawNativePreparedSend
    {
        throw OpenClawNativeActionError("Opening or composing must not submit a message.")
    }

    func inspect(_ run: OpenClawNativeRunRef) async throws -> OpenClawNativeRunInspection {
        throw OpenClawNativeActionError("Opening or composing must not inspect a run.")
    }
}
#endif
#endif
