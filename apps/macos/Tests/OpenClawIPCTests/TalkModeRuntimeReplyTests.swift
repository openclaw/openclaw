import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

enum TalkIncompleteReplyKind: CaseIterable, Sendable {
    case commentaryPhase, segment, signedCommentary, error, unresolvedToolCall
}

enum TalkCustodyCase: Equatable, Sendable {
    case absent, missingSession, missingActivity, missingReceipts, pendingReceipt, unknownReceipt
    case resetPending, resetPendingError, resetQueue
    case malformedProbe, unavailableProbe, cancelledUnknownReceipt
}

private actor TalkReplyWire {
    enum Scenario: Equatable, Sendable {
        case terminalAck
        case terminalSendFailure
        case acceptedTimeout
        case stopWhileWaiting
        case terminalFailure
        case malformedWait
        case permanentAuth
        case transientWaitError
        case routeChangeWhileWaiting
        case truncatedHistory
        case wrongFullMessageRun
        case incompleteWork(TalkIncompleteReplyKind)
        case custody(TalkCustodyCase)
    }

    static let runID = "synthetic-talk-run"
    static let sessionKey = "synthetic-talk-session"
    let scenario: Scenario
    private var methods: [String] = []
    private var waitRunIDs: [String] = []
    private var sendKeys: [String] = []
    private var waitCount = 0
    private var historyCount = 0
    private var custodyRunIDs: [[String]] = []
    private nonisolated let changed = AsyncTestSignal()
    private nonisolated let heldWaitEntered = AsyncTestGate()
    private nonisolated let heldWaitRelease = AsyncTestGate()
    nonisolated let routeSource = GatewayConnectionEndpointSource(url: URL(string: "ws://127.0.0.1:1")!)

    init(_ scenario: Scenario) {
        self.scenario = scenario
    }

    func waitFor(_ method: String, count: Int = 1) async throws {
        try await self.changed.wait("\(method) request \(count)") {
            self.methods.filter { $0 == method }.count >= count
        }
    }

    func waitUntilHeld() async throws {
        try await self.heldWaitEntered.wait("held agent.wait")
    }

    func releaseHeldWait() {
        self.heldWaitRelease.open()
    }

    func changeRoute() {
        self.routeSource.setURL(URL(string: "ws://127.0.0.1:2")!)
    }

    func snapshot() -> (methods: [String], waitRunIDs: [String], sendKeys: [String]) {
        (self.methods, self.waitRunIDs, self.sendKeys)
    }

    func requestedCustodyRunIDs() -> [[String]] {
        self.custodyRunIDs
    }

    func rejectCustodyProbe() -> Bool {
        self.scenario == .custody(.unavailableProbe) && self.custodyRunIDs.count == 1
    }

    func payload(method: String, params: [String: Any]) async throws -> String {
        self.methods.append(method)
        self.changed.notify()
        switch method {
        case "talk.config":
            return #"{"config":{}}"#
        case "chat.send":
            self.sendKeys.append(params["idempotencyKey"] as? String ?? "")
            let status = switch self.scenario {
            case .terminalAck: "ok"
            case .terminalSendFailure: "error"
            default: "started"
            }
            return #"{"runId":"\#(Self.runID)","status":"\#(status)"}"#
        case "agent.wait":
            return try await self.waitPayload(params: params)
        case "chat.history":
            return self.historyPayload(params: params)
        case "chat.message.get":
            let runID = self.scenario == .wrongFullMessageRun ? "foreign-run" : Self.runID
            let full = Self.message(id: "msg-1", runID: runID, text: "Complete matching reply")
            return #"{"ok":true,"message":\#(full)}"#
        default:
            throw URLError(.badServerResponse)
        }
    }

    private func waitPayload(params: [String: Any]) async throws -> String {
        self.waitRunIDs.append(params["runId"] as? String ?? "")
        self.waitCount += 1
        if self.scenario == .stopWhileWaiting || self.scenario == .routeChangeWhileWaiting {
            self.heldWaitEntered.open()
            await self.heldWaitRelease.wait()
        }
        if self.scenario == .permanentAuth {
            throw GatewayConnectAuthError(
                message: "synthetic scope rejection",
                detailCode: "AUTH_SCOPE_MISMATCH",
                canRetryWithDeviceToken: false)
        }
        if self.scenario == .transientWaitError, self.waitCount == 1 { throw URLError(.timedOut) }
        if self.scenario == .terminalFailure { return #"{"status":"failed","error":"synthetic failure"}"# }
        if self.scenario == .malformedWait { return "[]" }
        if self.scenario == .acceptedTimeout, self.waitCount == 1 { return #"{"status":"timeout"}"# }
        if case let .custody(kind) = self.scenario {
            if self.waitCount == 2 {
                switch kind {
                case .resetPending: return #"{"status":"pending"}"#
                case .resetPendingError: return #"{"status":"timeout","pendingError":true}"#
                case .resetQueue: return #"{"status":"timeout","timeoutPhase":"queue"}"#
                default: break
                }
            }
            if kind == .absent || self.waitCount == 1 ||
                ([TalkCustodyCase.unknownReceipt, .cancelledUnknownReceipt].contains(kind) && self.waitCount == 2) ||
                ([TalkCustodyCase.resetPending, .resetPendingError, .resetQueue].contains(kind) && self.waitCount <= 3)
            { return #"{"status":"timeout"}"# }
        }
        return #"{"status":"completed","endedAt":1}"#
    }

    private func historyPayload(params: [String: Any]) -> String {
        self.historyCount += 1
        if let inputRunIDs = params["inputRunIds"] as? [String] {
            self.custodyRunIDs.append(inputRunIDs)
            if case let .custody(kind) = self.scenario { return self.custodyPayload(kind) }
        }
        let messages: String = switch self.scenario {
        case .truncatedHistory:
            Self.message(id: "msg-1", runID: Self.runID, text: "cut", truncated: true)
        case .wrongFullMessageRun where self.historyCount == 1:
            Self.message(id: "msg-1", runID: Self.runID, text: "cut", truncated: true)
        case .wrongFullMessageRun:
            Self.message(id: "msg-2", runID: Self.runID, text: "Recovered matching reply")
        case let .incompleteWork(kind) where self.historyCount == 1:
            Self.incompleteMessage(kind)
        case .incompleteWork:
            Self.message(
                id: "final",
                runID: Self.runID,
                text: "Final spoken answer",
                content: #"""
                [{"type":"thinking","thinking":"Private draft"},
                 {"type":"text","text":"Final spoken answer"}]
                """#)
        case .terminalFailure:
            Self.message(id: "foreign", runID: "foreign-run", text: "Foreign reply")
        default:
            // The matching reply predates the send wall clock; a newer foreign answer
            // must not win merely because it is last in the history array.
            Self.message(id: "matching", runID: Self.runID, text: "Matching reply", timestamp: 1)
                + "," + Self.message(id: "foreign", runID: "foreign-run", text: "Foreign reply")
        }
        return #"{"sessionKey":"\#(Self.sessionKey)","messages":[\#(messages)]}"#
    }

    private func custodyPayload(_ kind: TalkCustodyCase) -> String {
        if kind == .malformedProbe { return #"{"sessionKey":"synthetic-talk-session","inputReceipts":"invalid"}"# }
        if [TalkCustodyCase.resetPending, .resetPendingError, .resetQueue].contains(kind),
           self.custodyRunIDs.count > 1
        {
            return #"""
            {"sessionKey":"\#(Self.sessionKey)","sessionId":"synthetic-session",
             "sessionInfo":{"hasActiveRun":false},
             "inputReceipts":[{"runId":"\#(Self.runID)","state":"pending"}],"messages":[]}
            """#
        }
        let metadata = switch kind {
        case .missingSession: #""sessionInfo":{"hasActiveRun":false},"inputReceipts":[]"#
        case .missingActivity: #""sessionId":"synthetic-session","inputReceipts":[]"#
        case .missingReceipts: #""sessionId":"synthetic-session","sessionInfo":{"hasActiveRun":false}"#
        case .pendingReceipt, .unknownReceipt:
            #"""
            "sessionId":"synthetic-session","sessionInfo":{"hasActiveRun":false},
            "inputReceipts":[{"runId":"\#(Self.runID)",
                              "state":"\#(kind == .pendingReceipt ? "pending" : "unknown")"}]
            """#
        case .cancelledUnknownReceipt:
            #"""
            "sessionId":"synthetic-session","sessionInfo":{"hasActiveRun":false},
            "inputReceipts":[{"runId":"\#(Self.runID)","state":"unknown","cancelled":true}]
            """#
        default: #""sessionId":"synthetic-session","sessionInfo":{"hasActiveRun":false},"inputReceipts":[]"#
        }
        let probeMessages = kind == .absent
            ? Self.message(id: "matching", runID: Self.runID, text: "Matching reply") : ""
        return #"{"sessionKey":"\#(Self.sessionKey)",\#(metadata),"messages":[\#(probeMessages)]}"#
    }

    private static func message(
        id: String,
        runID: String,
        text: String,
        timestamp: Int = 2_000_000_000,
        truncated: Bool = false,
        content: String? = nil) -> String
    {
        let blocks = content ?? #"[{"type":"text","text":"\#(text)"}]"#
        return #"""
        {"role":"assistant","timestamp":\#(timestamp),"content":\#(blocks),
        "__openclaw":{"id":"\#(id)","runId":"\#(runID)","truncated":\#(truncated)}}
        """#
    }

    private static func incompleteMessage(_ kind: TalkIncompleteReplyKind) -> String {
        let (fields, blocks) = switch kind {
        case .commentaryPhase:
            (#", "phase":"commentary""#, #"[{"type":"text","text":"Interim work"}]"#)
        case .segment:
            (
                #", "openclawStreamFallback":{"source":"segment","runId":"synthetic-talk-run","itemId":"progress"}"#,
                #"[{"type":"text","text":"Interim work"}]"#)
        case .signedCommentary:
            ("", #"[{"type":"text","text":"Interim work","textSignature":"{\"v\":1,\"phase\":\"commentary\"}"}]"#)
        case .error:
            (#", "isError":true,"stopReason":"error""#, #"[{"type":"text","text":"Interim work"}]"#)
        case .unresolvedToolCall:
            ("", #"[{"type":"text","text":"Interim work"},{"type":"toolCall","id":"call-1","name":"read"}]"#)
        }
        return #"""
        {"role":"assistant","__openclaw":{"id":"progress","runId":"\#(Self.runID)"}\#(fields),
         "content":\#(blocks)}
        """#
    }
}

private actor TalkReplySink {
    private var played: [String] = []
    private var restartCount = 0

    func play(_ text: String) {
        self.played.append(text)
    }

    func restart() {
        self.restartCount += 1
    }

    func snapshot() -> (played: [String], restartCount: Int) {
        (self.played, self.restartCount)
    }
}

private func makeTalkReplyFixture(
    _ scenario: TalkReplyWire.Scenario) async -> (TalkModeRuntime, GatewayConnection, TalkReplyWire, TalkReplySink)
{
    let wire = TalkReplyWire(scenario)
    let sink = TalkReplySink()
    let socketSession = GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
            guard sendIndex > 0 else { return }
            let data: Data = switch message {
            case let .data(value): value
            case let .string(value): Data(value.utf8)
            @unknown default: throw URLError(.cannotParseResponse)
            }
            guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = frame["id"] as? String,
                  let method = frame["method"] as? String
            else { throw URLError(.cannotParseResponse) }
            let params = frame["params"] as? [String: Any] ?? [:]
            let isCustodyProbe = method == "chat.history" && params["inputRunIds"] != nil
            let payload = try await wire.payload(method: method, params: params)
            if isCustodyProbe, await wire.rejectCustodyProbe() {
                try socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.errorResponseData(
                    id: id, code: "UNAVAILABLE", message: "synthetic custody outage", details: [:])))
                return
            }
            socket.emitReceiveSuccess(.data(Data(
                #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)))
        })
    })
    let gateway = GatewayConnection(
        configProvider: { wire.routeSource.snapshot().config },
        sessionBox: WebSocketSessionBox(session: socketSession))
    let live = TalkModeRuntime.Dependencies.live
    let dependencies = TalkModeRuntime.Dependencies(
        permissions: .init(supported: { false }, granted: { false }, ensure: { _ in false }),
        audioCapture: live.audioCapture,
        pcmPlayer: live.pcmPlayer,
        selectedSession: { TalkReplyWire.sessionKey },
        stopPCM: { nil },
        stopMP3: { nil },
        stopBuffered: { nil },
        stopSystem: {},
        stopMLX: {})
    let runtime = TalkModeRuntime(state: { nil }, controller: { nil }, dependencies: dependencies, gateway: gateway)
    await runtime._test_enableForReply()
    await runtime._test_installReplySinks(sink)
    return (runtime, gateway, wire, sink)
}

private func withTalkReplyFixture(
    _ scenario: TalkReplyWire.Scenario,
    _ body: (TalkModeRuntime, TalkReplyWire, TalkReplySink) async throws -> Void) async throws
{
    let (runtime, gateway, wire, sink) = await makeTalkReplyFixture(scenario)
    do {
        try await body(runtime, wire, sink)
        await gateway.shutdown()
    } catch {
        await wire.releaseHeldWait()
        await gateway.shutdown()
        throw error
    }
}

extension TalkModeRuntime {
    fileprivate func _test_enableForReply() {
        self.isEnabled = true
    }

    fileprivate func _test_installReplySinks(_ sink: TalkReplySink) {
        self.assistantPlaybackOverride = { text in await sink.play(text) }
        self.listeningRestartOverride = { await sink.restart() }
    }
}

@Suite(.testWaitLimit)
struct TalkModeRuntimeReplyTests {
    @Test func `terminal send ack never speaks the newer foreign reply`() async throws {
        try await withTalkReplyFixture(.terminalAck) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let delivery = await sink.snapshot()
            #expect(delivery.played == ["Matching reply"])
            #expect(await wire.snapshot().methods.contains("chat.history"))
        }
    }

    @Test func `terminal send failure never waits or reads history`() async throws {
        try await withTalkReplyFixture(.terminalSendFailure) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let requests = await wire.snapshot()
            #expect(requests.methods.contains("chat.send"))
            #expect(requests.methods.contains("agent.wait") == false)
            #expect(requests.methods.contains("chat.history") == false)
            #expect(await sink.snapshot().played.isEmpty)
        }
    }

    @Test func `accepted run survives observation timeout and speaks once`() async throws {
        try await withTalkReplyFixture(.acceptedTimeout) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let requests = await wire.snapshot()
            #expect(requests.waitRunIDs == [TalkReplyWire.runID, TalkReplyWire.runID])
            #expect(requests.sendKeys.count == 1)
            #expect(await sink.snapshot().played == ["Matching reply"])
        }
    }

    @Test func `Stop invalidates a late completed run before playback`() async throws {
        try await withTalkReplyFixture(.stopWhileWaiting) { runtime, wire, sink in
            let sending = Task { await runtime.sendAndSpeak("synthetic") }
            do {
                try await wire.waitUntilHeld()
                await runtime.setEnabled(false)
                await wire.releaseHeldWait()
                try await TestWait.value(of: sending, "stopped send")
            } catch {
                sending.cancel()
                await wire.releaseHeldWait()
                _ = await sending.value
                throw error
            }
            let delivery = await sink.snapshot()
            #expect(delivery.played.isEmpty)
            #expect(delivery.restartCount == 0)
        }
    }

    @Test func `terminal run failure never plays a foreign history answer`() async throws {
        try await withTalkReplyFixture(.terminalFailure) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            #expect(await sink.snapshot().played.isEmpty)
            #expect(await wire.snapshot().waitRunIDs == [TalkReplyWire.runID])
        }
    }

    @Test func `malformed wait response is terminal without foreign playback`() async throws {
        try await withTalkReplyFixture(.malformedWait) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let requests = await wire.snapshot()
            #expect(requests.waitRunIDs == [TalkReplyWire.runID])
            #expect(requests.methods.contains("chat.history") == false)
            #expect(await sink.snapshot().played.isEmpty)
        }
    }

    @Test func `nonrecoverable auth rejection ends accepted run without playback`() async throws {
        try await withTalkReplyFixture(.permanentAuth) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let requests = await wire.snapshot()
            let delivery = await sink.snapshot()
            #expect(requests.sendKeys.count == 1)
            #expect(requests.waitRunIDs == [TalkReplyWire.runID])
            #expect(requests.methods.contains("chat.history") == false)
            #expect(delivery.played.isEmpty)
            #expect(delivery.restartCount == 1)
        }
    }

    @Test(arguments: [false, true])
    func `route change invalidates held reply and resumes only while enabled`(stop: Bool) async throws {
        try await withTalkReplyFixture(.routeChangeWhileWaiting) { runtime, wire, sink in
            let sending = Task { await runtime.sendAndSpeak("synthetic") }
            do {
                try await wire.waitUntilHeld()
                await wire.changeRoute()
                if stop { await runtime.setEnabled(false) }
                await wire.releaseHeldWait()
                try await TestWait.value(of: sending, "route-changed send")
            } catch {
                sending.cancel()
                await wire.releaseHeldWait()
                _ = await sending.value
                throw error
            }
            let delivery = await sink.snapshot()
            #expect(delivery.played.isEmpty)
            #expect(delivery.restartCount == (stop ? 0 : 1))
            #expect(await wire.snapshot().sendKeys.count == 1)
        }
    }

    @Test func `two bare timeouts with explicit absent custody end without speech`() async throws {
        try await withTalkReplyFixture(.custody(.absent)) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            #expect(await wire.snapshot().waitRunIDs == [TalkReplyWire.runID, TalkReplyWire.runID])
            #expect(await wire.requestedCustodyRunIDs() == [[TalkReplyWire.runID]])
            let delivery = await sink.snapshot()
            #expect(delivery.played.isEmpty)
            #expect(delivery.restartCount == 1)
        }
    }

    @Test(arguments: [
        TalkCustodyCase.missingSession,
        .missingActivity,
        .missingReceipts,
        .pendingReceipt,
        .unknownReceipt,
    ])
    func `incomplete or retained custody keeps observing through completion`(_ kind: TalkCustodyCase) async throws {
        try await withTalkReplyFixture(.custody(kind)) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            #expect(await wire.requestedCustodyRunIDs().allSatisfy { $0 == [TalkReplyWire.runID] })
            #expect(await wire.requestedCustodyRunIDs().isEmpty == false)
            #expect(await sink.snapshot().played == ["Matching reply"])
        }
    }

    @Test(arguments: [TalkCustodyCase.resetPending, .resetPendingError, .resetQueue])
    func `renewed pending evidence clears earlier absent custody`(_ kind: TalkCustodyCase) async throws {
        try await withTalkReplyFixture(.custody(kind)) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            #expect(await wire.snapshot().waitRunIDs.count == 4)
            #expect(await wire.requestedCustodyRunIDs() == [[TalkReplyWire.runID], [TalkReplyWire.runID]])
            #expect(await sink.snapshot().played == ["Matching reply"])
        }
    }

    @Test(arguments: [TalkCustodyCase.malformedProbe, .unavailableProbe, .cancelledUnknownReceipt])
    func `uncertain custody probe continues the accepted run`(_ kind: TalkCustodyCase) async throws {
        try await withTalkReplyFixture(.custody(kind)) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let requests = await wire.snapshot()
            #expect(requests.sendKeys.count == 1)
            #expect(requests.waitRunIDs.count == (kind == .cancelledUnknownReceipt ? 3 : 2))
            #expect(requests.waitRunIDs.allSatisfy { $0 == TalkReplyWire.runID })
            #expect(await wire.requestedCustodyRunIDs().count == (kind == .cancelledUnknownReceipt ? 2 : 1))
            #expect(await sink.snapshot().played == ["Matching reply"])
        }
    }

    @Test func `transient observation request error retries the same accepted run`() async throws {
        try await withTalkReplyFixture(.transientWaitError) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let requests = await wire.snapshot()
            #expect(requests.waitRunIDs == [TalkReplyWire.runID, TalkReplyWire.runID])
            #expect(requests.sendKeys.count == 1)
            #expect(await sink.snapshot().played == ["Matching reply"])
        }
    }

    @Test func `truncated history is fetched in full before speaking`() async throws {
        try await withTalkReplyFixture(.truncatedHistory) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            #expect(await wire.snapshot().methods.contains("chat.message.get"))
            #expect(await sink.snapshot().played == ["Complete matching reply"])
        }
    }

    @Test func `full message from a different run is rejected and history revalidated`() async throws {
        try await withTalkReplyFixture(.wrongFullMessageRun) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let methods = await wire.snapshot().methods
            #expect(methods.filter { $0 == "chat.history" }.count >= 2)
            #expect(methods.contains("chat.message.get"))
            #expect(await sink.snapshot().played == ["Recovered matching reply"])
        }
    }

    @Test(arguments: TalkIncompleteReplyKind.allCases)
    func `same run work waits for visible final answer`(_ kind: TalkIncompleteReplyKind) async throws {
        try await withTalkReplyFixture(.incompleteWork(kind)) { runtime, wire, sink in
            await runtime.sendAndSpeak("synthetic")
            let delivery = await sink.snapshot()
            #expect(delivery.played == ["Final spoken answer"])
            #expect(await wire.snapshot().methods.filter { $0 == "chat.history" }.count >= 2)
        }
    }
}
