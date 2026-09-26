import AppKit
import OpenClawChatUI
import OpenClawProtocol
import SwiftUI
import Testing

@MainActor
extension QuickChatCatalogPresentationTests {
    @Test func `rendered transcript recovers a missing reply from selected message invalidation`() async throws {
        try await TestIsolation.withIsolatedState {
            try await AppKitTestSupport.startApplication()
            let suite = "ai.openclaw.history-recovery-test.\(UUID().uuidString)"
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let transport = HistoryRecoveryPresentationTransport()
            let model = OpenClawChatViewModel(
                sessionKey: "global", transport: transport, activeAgentId: "main",
                modelPickerStore: ChatModelPickerStore(defaults: defaults))
            defer {
                transport.finish()
                model.detachTransport()
            }
            let hosting = NSHostingView(rootView: OpenClawChatView(
                viewModel: model,
                drawsBackground: false,
                showsAssistantAvatars: false,
                composerChrome: .clean)
                .environment(\.openClawChatDesktopLayout, true)
                // Foreground transitions must not refresh history independently of the invalidation.
                .environment(\.scenePhase, .active)
                .environment(\.colorScheme, .light)
                .defaultAppStorage(defaults)
                .background(OpenClawChatTheme.desktopCanvas(in: .light))
                .frame(width: 900, height: 560))
            hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 560)
            let window = NSWindow(
                contentRect: NSRect(x: 60, y: 60, width: 900, height: 560),
                styleMask: [], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.title = "OpenClaw — History recovery fixture"
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = hosting
            defer { window.close() }
            window.orderFront(nil)

            // The production view's onAppear owns the initial history load.
            try #require(await Self.waitForHistoryPresentation {
                !model.isLoading && model.messages.count == 1 && model.healthOK
            })
            let initialRequests = await transport.historyRequests
            try #require(initialRequests == ["global"])
            try #require(model.currentSessionTarget.agentID == "main")

            await transport.emit(sessionKey: "agent:main:unrelated", agentID: "main")
            await transport.emit(sessionKey: "global", agentID: "other")

            // The reply was persisted, but live delivery was replaced by invalidation.
            await transport.publishMissingReply()
            let recovered = try await Self.waitForHistoryPresentation {
                model.messages.contains { message in
                    message.content.contains { $0.text == HistoryRecoveryPresentationTransport.reply }
                }
            }
            let requests = await transport.historyRequests
            let deliveredEvents = await transport.deliveredEvents
            let texts = model.messages.flatMap { $0.content.compactMap(\.text) }
            try await Self.captureHistoryPresentation(
                window, model: model, recovered: recovered, requests: requests,
                deliveredEvents: deliveredEvents)

            // Capture first: the unchanged owner must leave visible evidence when this fails.
            #expect(recovered, "Selected message invalidation must recover the persisted assistant reply")
            #expect(requests == ["global", "global"])
            #expect(texts == [
                HistoryRecoveryPresentationTransport.question,
                HistoryRecoveryPresentationTransport.reply,
            ])
            #expect(model.sessionKey == "global")
            #expect(model.currentSessionTarget.agentID == "main")
            #expect(model.errorText == nil)
        }
    }

    private static func waitForHistoryPresentation(_ condition: @MainActor () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        repeat {
            if condition() { return true }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        return condition()
    }

    private static func captureHistoryPresentation(
        _ window: NSWindow,
        model: OpenClawChatViewModel,
        recovered: Bool,
        requests: [String],
        deliveredEvents: [String]) async throws
    {
        let directory = try #require(ProcessInfo.processInfo.environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"])
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        let name = "history-message-recovery"
        try await Task.sleep(for: .milliseconds(350))
        try #require(window.isVisible)
        let content = try #require(window.contentView)
        content.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let bitmap = try #require(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: output.appendingPathComponent("\(name)-window.png"))
        let visibleTexts = model.messages.flatMap { $0.content.compactMap(\.text) }
        let receipt: [String: Any] = [
            "name": name,
            "method": "NSView.cacheDisplay",
            "synthetic": true,
            "requiresVisualInspection": true,
            "recoveredBeforeDeadline": recovered,
            "recoveredAtCapture": visibleTexts.contains(HistoryRecoveryPresentationTransport.reply),
            "sessionKey": model.sessionKey,
            "agentID": model.currentSessionTarget.agentID ?? "",
            "historyRequests": requests,
            "deliveredEvents": deliveredEvents,
            "visibleTexts": visibleTexts,
            "windowVisible": window.isVisible,
            "pngs": ["\(name)-window.png"],
        ]
        try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("\(name)-capture-status.json"))
    }
}

private actor HistoryRecoveryPresentationTransport: OpenClawChatTransport {
    static let question = "How many messages are in this archive?"
    static let reply = "The archive contains 12 messages. The missing reply is now visible."
    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation
    private var replyAvailable = false
    private(set) var historyRequests: [String] = []
    private(set) var deliveredEvents: [String] = []

    init() {
        (self.stream, self.continuation) = AsyncStream.makeStream()
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }

    nonisolated func finish() {
        self.continuation.finish()
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        self.historyRequests.append(sessionKey)
        var messages = [Self.message(role: "user", text: Self.question, timestamp: 1_700_000_000_000)]
        if self.replyAvailable {
            messages.append(Self.message(role: "assistant", text: Self.reply, timestamp: 1_700_000_001_000))
        }
        return .init(
            sessionKey: sessionKey, sessionId: "synthetic-history-recovery", messages: messages,
            thinkingLevel: "off", sessionInfo: .init(
                hasActiveRun: false,
                activeRunIds: [],
                key: "global",
                agentId: "main"))
    }

    private static func message(role: String, text: String, timestamp: Double) -> AnyCodable {
        AnyCodable(["role": role, "timestamp": timestamp, "content": [["type": "text", "text": text]]])
    }

    func emit(sessionKey: String, agentID: String) {
        self.deliveredEvents.append("\(agentID):\(sessionKey):message")
        self.continuation.yield(.sessionsChanged(.init(
            sessionKey: sessionKey, agentId: agentID, phase: "message")))
    }

    func publishMissingReply() {
        self.replyAvailable = true
        self.emit(sessionKey: "global", agentID: "main")
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func gatewayAdvertisesMethod(_: String) async -> Bool? {
        false
    }

    func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        .init(defaultId: "main", agents: [.init(id: "main", name: "Assistant", emoji: "🦞")])
    }

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
        [.init(
            modelID: "assistant",
            name: "Assistant",
            provider: "fixture",
            available: true,
            manualSelectionAllowed: true,
            contextWindow: 128_000)]
    }

    func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data("""
        {"defaults":{"modelProvider":"fixture","model":"assistant","contextTokens":128000},
         "sessions":[{"key":"global","agentId":"main","displayName":"Archive question","updatedAt":1700000001000}]}
        """.utf8))
    }

    func sendMessage(
        sessionKey _: String, message _: String, thinking _: String, idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw URLError(.unsupportedURL)
    }
}
