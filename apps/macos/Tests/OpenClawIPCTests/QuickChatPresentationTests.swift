import AppKit
import OpenClawChatUI
import OpenClawProtocol
import SwiftUI
import XCTest
@testable import OpenClaw

@MainActor
final class QuickChatPresentationTests: XCTestCase {
    func testConversationDisclosurePreservesOneComposerAndItsDraft() async throws {
        let application = AppKitTestSupport.application
        let suiteName = "ai.openclaw.quickchat-proof.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let transport = QuickChatPresentationTransport()
        let options = ["off", "low", "medium", "high"].map {
            OpenClawChatThinkingLevelOption(id: $0, label: $0.capitalized)
        }
        let choice = OpenClawChatModelChoice(
            modelID: "gpt-5.5", name: "GPT-5.5", provider: "openai",
            available: true, manualSelectionAllowed: true, contextWindow: 128_000,
            reasoning: true, thinkingLevels: options)
        let model = QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main", mainkey: "main", scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Claw")])
            },
            agentIdentityProvider: { _ in .init(id: "main", name: "Claw", emoji: "🦞") },
            sendProvider: { _, _, _, _, key, _ in
                await transport.accept(key: key)
                return "ok"
            },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available },
            frontmostAppNameProvider: { "Notes" },
            modelControlsProvider: { _ in
                QuickChatModelControlSnapshot(
                    models: [choice], currentModelSelectionID: "openai/gpt-5.5",
                    currentThinkingLevel: "high", thinkingOptions: options, defaultProvider: "openai")
            },
            modelCatalogEventsProvider: { AsyncStream { $0.finish() } },
            settingsPatchProvider: { _, _ in nil })
        let controller = QuickChatController(
            enableUI: true, model: model, monitoringEnabled: false,
            hotkeyRegistrar: { _ in }, hotkeyRemover: {}, chatOpener: { _, _ in },
            recentSessionsProvider: {
                [.init(
                    id: "agent:main:notes", key: "agent:main:notes", kind: .direct,
                    displayName: "Release notes", updatedAt: Date(), sessionId: nil,
                    thinkingLevel: nil, verboseLevel: nil,
                    tokens: .init(total: 0, contextTokens: 0))]
            },
            replyViewModelFactory: {
                OpenClawChatViewModel(
                    sessionKey: $0.sessionKey, transport: transport, activeAgentId: $0.agentID,
                    modelPickerStore: ChatModelPickerStore(defaults: defaults))
            })
        defer { controller.stop() }
        controller.present()
        try await self.waitUntil { model.canUseModelControls && !model.isLoadingModelControls }
        let panel = try XCTUnwrap(application.windows.first {
            ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
        })
        panel.appearance = NSAppearance(named:
            ProcessInfo.processInfo.environment["OPENCLAW_TEST_QUICKCHAT_APPEARANCE"] == "dark" ? .darkAqua : .aqua)
        let content = try XCTUnwrap(panel.contentView)
        try await self.captureQuickChat(content, name: "collapsed")
        XCTAssertEqual(self.composerCount(in: content), 1)

        model.text = "Clean up the confirmed test sessions."
        let accepted = await model.send()
        XCTAssertTrue(accepted)
        controller.handleSendAcceptedForTesting(openChat: false)
        let reply = try XCTUnwrap(controller.replyBinding.viewModel)
        try await self.waitUntil {
            reply.messages.count == 2 && !reply.isLoading &&
                reply.contextUsage != nil && reply.progressCard?.steps?.count == 2
        }
        XCTAssertEqual(reply.contextUsage?.percentUsed, 46)
        XCTAssertEqual(reply.progressCard?.steps?.count, 2)
        XCTAssertNil(reply.modelCatalogMessage)
        let contextControl = try await AppKitTestSupport.waitForAccessibilityElement(
            in: panel, description: "the context usage control")
        { elements in
            elements.first { $0.accessibilityLabel?() == "Context usage" }
        }
        let contextValue: Any? = contextControl.accessibilityValue?()
        XCTAssertEqual(contextValue as? String, "46 percent of the context window used")
        model.text = "Can you show me what changed?"
        try await self.captureQuickChat(content, name: "expanded")
        XCTAssertEqual(self.composerCount(in: content), 1, "Expanded Quick Chat must keep a single composer")
        XCTAssertEqual(reply.sessionKey, "agent:main:main")

        await transport.beginThinking()
        try await self.waitUntil { reply.streamingAssistantText != nil }
        let streamingText = try XCTUnwrap(reply.streamingAssistantText)
        _ = try await AppKitTestSupport.waitForAccessibilityElement(
            in: panel, description: "the live reply before collapsing")
        { elements in
            elements
                .first { element in
                    let value: Any? = element.accessibilityValue?()
                    return (value as? String)?.contains("I am checking the remaining conversations.") == true
                }
        }
        let releaseHistory = AsyncTestGate()
        defer { releaseHistory.open() }
        await transport.holdHistory(until: releaseHistory)

        controller.toggleReply()
        try await self.waitForDisclosure(in: panel, expanded: false)
        XCTAssertTrue(controller.replyBinding.viewModel === reply)
        XCTAssertEqual(model.text, "Can you show me what changed?")
        try await self.captureQuickChat(content, name: "collapsed-with-draft")
        XCTAssertEqual(self.composerCount(in: content), 1)

        controller.toggleReply()
        try await self.waitForDisclosure(in: panel, expanded: true)
        XCTAssertTrue(controller.replyBinding.viewModel === reply)
        XCTAssertEqual(model.text, "Can you show me what changed?")
        XCTAssertEqual(
            reply.streamingAssistantText,
            streamingText,
            "Reopening must retain the live reply while history is unavailable")
        XCTAssertFalse(reply.isLoading, "Reopening must not restart history bootstrap")
        releaseHistory.open()

        try await self.captureQuickChat(content, name: "thinking")
        XCTAssertEqual(model.text, "Can you show me what changed?")

        let sendEntered = AsyncTestGate()
        let acknowledgeSend = AsyncTestGate()
        defer { acknowledgeSend.open() }
        await transport.holdNextSend(entered: sendEntered, acknowledgement: acknowledgeSend)
        let pendingSend = Task { await model.send() }
        await sendEntered.wait()
        controller.toggleReply()
        try await self.waitForDisclosure(in: panel, expanded: false)
        acknowledgeSend.open()
        let followupAccepted = await pendingSend.value
        XCTAssertTrue(followupAccepted)
        controller.handleSendAcceptedForTesting(openChat: false)
        try await self.waitForDisclosure(in: panel, expanded: false)
        model.text = "Keep this next draft."

        let history = try await AppKitTestSupport.waitForAccessibilityElement(
            in: panel, description: "the recent conversations button")
        { elements in
            elements.first { $0.accessibilityLabel?() == "Continue a recent conversation" }
        }
        try await AppKitTestSupport.openMenu(history, in: panel) { menu in
            let index = try XCTUnwrap(menu.items.firstIndex { $0.title.hasPrefix("Release notes") })
            menu.performActionForItem(at: index)
        }
        try await self.waitUntil { model.sessionKey == "agent:main:notes" }
        XCTAssertNil(controller.replyBinding.route)
        XCTAssertNil(controller.replyBinding.viewModel, "Hidden replies cannot retain another conversation's context")
        XCTAssertEqual(model.text, "Keep this next draft.")
    }

    private func waitForDisclosure(in panel: NSWindow, expanded: Bool) async throws {
        _ = try await AppKitTestSupport.waitForAccessibilityElement(
            in: panel, description: expanded ? "the expanded conversation" : "the collapsed composer")
        { elements in
            elements.first {
                $0.accessibilityLabel?() == (expanded ? "Collapse conversation" : "Expand conversation")
            }
        }
        // SwiftUI retains outgoing views until their transition finishes.
        let deadline = ContinuousClock.now + .seconds(5)
        var frame = panel.frame
        var stableSince = ContinuousClock.now
        repeat {
            try await Task.sleep(for: .milliseconds(20))
            if panel.frame != frame {
                frame = panel.frame
                stableSince = .now
            }
            let hasExpectedSize = expanded ? frame.height > 400 : frame.height < 200
            if hasExpectedSize, stableSince.duration(to: .now) >= .milliseconds(350) {
                return
            }
        } while ContinuousClock.now < deadline
        XCTFail("The conversation disclosure animation must settle")
    }

    private func composerCount(in view: NSView) -> Int {
        (view is NSTextView ? 1 : 0) + view.subviews.reduce(0) { $0 + self.composerCount(in: $1) }
    }

    private func captureQuickChat(_ view: NSView, name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["OPENCLAW_TEST_QUICKCHAT_CAPTURE_DIR"] else {
            return
        }
        if ProcessInfo.processInfo.environment["OPENCLAW_TEST_QUICKCHAT_EXTERNAL_CAPTURE"] == "1" {
            let output = URL(fileURLWithPath: directory, isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            try await AppKitTestSupport.recordCompositedWindow(
                XCTUnwrap(view.window), name: "quickchat-\(name)", directory: output)
            return
        }
        // Capture after the panel's presentation and content-size animation settle.
        try await Task.sleep(for: .milliseconds(350))
        view.layoutSubtreeIfNeeded()
        let image = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: image)
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try XCTUnwrap(image.representation(using: .png, properties: [:]))
            .write(to: output.appendingPathComponent("\(name).png"))
    }

    func testShortcutPresentsAnEditorWithoutRequiringForegroundOwnership() async throws {
        let application = AppKitTestSupport.application
        XCTAssertTrue(AppKitTestSupport.didSetActivationPolicy)
        var shortcut: (() -> Void)?
        let model = QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main", mainkey: "main", scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Fixture")])
            },
            agentIdentityProvider: { _ in .placeholder },
            permissionStatusProvider: { _ in [:] },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in .testFixture })
        let controller = QuickChatController(
            enableUI: true,
            model: model,
            monitoringEnabled: false,
            hotkeyRegistrar: { shortcut = $0 },
            hotkeyRemover: { shortcut = nil },
            allowsHotkeyRegistrationInTests: true)
        defer { controller.stop() }
        controller.start()
        controller.setEnabled(true)
        application.deactivate()
        try await self.waitUntil { !application.isActive }
        try XCTUnwrap(shortcut)()

        try await self.waitUntil { controller.isVisible && !model.isLoadingModelControls }
        let panel = try XCTUnwrap(application.windows.first {
            ($0.contentView as? NSHostingView<QuickChatView>)?.rootView.model === model
        })
        XCTAssertTrue(panel.isVisible)
        XCTAssertFalse(panel.hidesOnDeactivate)
        try await self.waitUntil { panel.firstResponder is NSTextView }
        XCTAssertTrue(panel.firstResponder is NSTextView)
        print(
            "Quick Chat presented: visible=\(panel.isVisible), active=\(application.isActive), key=\(panel.isKeyWindow), editorReady=\(panel.firstResponder is NSTextView)")

        let content = try XCTUnwrap(panel.contentView)
        content.layoutSubtreeIfNeeded()
        let image = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: image)
        let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("quick-chat-proof", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try XCTUnwrap(image.representation(using: .png, properties: [:]))
            .write(to: output.appendingPathComponent("presented.png"))

        controller.dismiss()
        try XCTUnwrap(shortcut)()
        try await self.waitUntil { controller.isVisible }
        XCTAssertTrue(panel.isVisible)
        print("Quick Chat reopened: visible=\(panel.isVisible)")
        controller.setEnabled(false)
        XCTAssertFalse(controller.isVisible)
        XCTAssertNil(shortcut)
        print("Quick Chat disabled: visible=\(controller.isVisible), shortcutRegistered=\(shortcut != nil)")
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition())
    }
}

private actor QuickChatPresentationTransport: OpenClawChatTransport {
    nonisolated let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation
    private var acceptedKey = ""
    private var heldSend: (entered: AsyncTestGate, acknowledgement: AsyncTestGate)?
    private var historyRelease: AsyncTestGate?

    init() {
        (self.stream, self.continuation) = AsyncStream.makeStream()
    }

    func accept(key: String) async {
        self.acceptedKey = key
        if let heldSend = self.heldSend {
            self.heldSend = nil
            heldSend.entered.open()
            await heldSend.acknowledgement.wait()
        }
    }

    func holdNextSend(entered: AsyncTestGate, acknowledgement: AsyncTestGate) {
        self.heldSend = (entered, acknowledgement)
    }

    func holdHistory(until release: AsyncTestGate) {
        self.historyRelease = release
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func gatewayAdvertisesMethod(_ method: String) async -> Bool? {
        method == "progressCard.get"
    }

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
        [.init(
            modelID: "gpt-5.5", name: "GPT-5.5", provider: "openai",
            available: true, manualSelectionAllowed: true, contextWindow: 128_000,
            reasoning: true,
            thinkingLevels: ["off", "low", "medium", "high"].map { .init(id: $0, label: $0.capitalized) })]
    }

    func loadModelCatalog(
        sessionKey _: String, agentID: String?) async throws -> OpenClawChatModelCatalogSnapshot
    {
        try await .init(choices: self.listModels(agentID: agentID), availabilityIsSessionScoped: true)
    }

    func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        .init(defaultId: "main", agents: [.init(id: "main", name: "Claw", emoji: "🦞")])
    }

    func listSessions(
        limit _: Int?, search _: String?, archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data("""
        {"defaults":{"modelProvider":"openai","model":"gpt-5.5","contextTokens":128000,"modelSelectionTarget":"session"},
         "sessions":[{"key":"agent:main:main","agentId":"main","displayName":"Today",
          "modelProvider":"openai","model":"gpt-5.5","contextTokens":128000,"totalTokens":58400,
          "thinkingLevel":"high"}]}
        """.utf8))
    }

    func listSessions(
        limit: Int?, search: String?, archived: Bool,
        agentID _: String?) async throws -> OpenClawChatSessionsListResponse
    {
        try await self.listSessions(limit: limit, search: search, archived: archived)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        if let historyRelease = self.historyRelease {
            await historyRelease.wait()
        }
        let messages = [
            AnyCodable([
                "role": "user", "content": [["type": "text", "text": "Clean up the confirmed test sessions."]],
                "timestamp": 1_789_859_600_000,
                "__openclaw": ["idempotencyKey": self.acceptedKey],
            ]),
            AnyCodable([
                "role": "assistant", "content": [[
                    "type": "text",
                    "text": "Done. I removed the two confirmed test sessions and verified that your active conversations are untouched.",
                ]],
                "timestamp": 1_789_859_605_000,
            ]),
        ]
        return .init(
            sessionKey: sessionKey, sessionId: "synthetic-quickchat", messages: messages,
            thinkingLevel: "high",
            sessionInfo: .init(hasActiveRun: false, activeRunIds: [], key: sessionKey, agentId: "main"))
    }

    func sendMessage(
        sessionKey _: String, message _: String, thinking _: String, idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw URLError(.unsupportedURL)
    }

    func fetchProgressCard(sessionKey: String, agentID _: String?) async throws -> ProgressCard? {
        .init(
            sessionkey: sessionKey, revision: 1, updatedat: 1_789_859_605_000,
            steps: [
                .init(step: "Identify confirmed test sessions", status: .completed),
                .init(step: "Delete test sessions and verify", status: .completed),
            ])
    }

    func beginThinking() {
        self.continuation.yield(.chat(.init(
            runId: "synthetic-run", sessionKey: "agent:main:main", state: "delta",
            message: AnyCodable([
                "role": "assistant", "content": [[
                    "type": "text",
                    "text": "<think>Reviewing the changes.</think>I am checking the remaining conversations.",
                ]],
            ]), errorMessage: nil)))
    }
}
