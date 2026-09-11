import AppKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@Suite(.serialized)
@MainActor
struct WebChatSwiftUISmokeTests {
    private struct TestTransport: OpenClawChatTransport {
        func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
            let json = """
            {"sessionKey":"\(sessionKey)","sessionId":null,"messages":[],"thinkingLevel":"off"}
            """
            return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data(json.utf8))
        }

        func sendMessage(
            sessionKey _: String,
            message _: String,
            thinking _: String,
            idempotencyKey _: String,
            attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
        {
            let json = """
            {"runId":"\(UUID().uuidString)","status":"ok"}
            """
            return try JSONDecoder().decode(OpenClawChatSendResponse.self, from: Data(json.utf8))
        }

        func createSession(
            key: String,
            label _: String?,
            agentID: String?,
            parentSessionKey: String?,
            worktree _: Bool?,
            worktreeBaseRef _: String?) async throws -> OpenClawChatCreateSessionResponse
        {
            #expect(OpenClawChatSessionKey.agentID(from: key) == agentID)
            #expect(parentSessionKey == nil)
            return try JSONDecoder().decode(
                OpenClawChatCreateSessionResponse.self,
                from: JSONEncoder().encode(["key": key]))
        }

        func requestHealth(timeoutMs _: Int) async throws -> Bool {
            true
        }

        func events() -> AsyncStream<OpenClawChatTransportEvent> {
            AsyncStream { continuation in
                continuation.finish()
            }
        }

        func setActiveSessionKey(_: String) async throws {}
    }

    @Test func `response and thinking headings keep their semantic typography`() {
        #expect(ChatMarkdownRenderer.Typography.response.headingStyle == .hierarchy)
        #expect(ChatMarkdownRenderer.Typography.thinking.headingStyle == .prose)
    }

    @Test func `assistant segments select one complete markdown typography profile`() {
        let segments = AssistantTextParser.segments(
            from: "<think># Internal plan</think><final># Final answer</final>")

        #expect(segments.map(\.kind.markdownTypography) == [.thinking, .response])
    }

    @Test func `session observer remains visible until the last shared gateway window closes`() {
        var owners = WebChatSessionObserverVisibilityOwners()
        let firstConnection = NSObject()
        let secondConnection = NSObject()
        let firstWindow = NSObject()
        let secondWindow = NSObject()
        let independentWindow = NSObject()
        let sharedConnectionID = ObjectIdentifier(firstConnection)
        let independentConnectionID = ObjectIdentifier(secondConnection)

        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(firstWindow),
            connection: sharedConnectionID) == true)
        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(firstWindow),
            connection: sharedConnectionID) == nil)
        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(secondWindow),
            connection: sharedConnectionID) == nil)
        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(independentWindow),
            connection: independentConnectionID) == true)
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(firstWindow),
            connection: sharedConnectionID) == nil)
        #expect(owners.isVisible(connection: sharedConnectionID))
        #expect(owners.isVisible(connection: independentConnectionID))
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(secondWindow),
            connection: sharedConnectionID) == false)
        #expect(!owners.isVisible(connection: sharedConnectionID))
        #expect(owners.isVisible(connection: independentConnectionID))
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(secondWindow),
            connection: sharedConnectionID) == nil)
    }

    @Test func `reopening a gateway window restores visibility after the last owner closes`() {
        var owners = WebChatSessionObserverVisibilityOwners()
        let connection = NSObject()
        let closingWindow = NSObject()
        let reopeningWindow = NSObject()
        let connectionID = ObjectIdentifier(connection)

        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(closingWindow),
            connection: connectionID) == true)
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(closingWindow),
            connection: connectionID) == false)
        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(reopeningWindow),
            connection: connectionID) == true)
        #expect(owners.isVisible(connection: connectionID))
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(closingWindow),
            connection: connectionID) == nil)
        #expect(owners.isVisible(connection: connectionID))
    }

    @Test func `window controller merges titlebar and keeps toolbar controls`() throws {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            transport: TestTransport(),
            windowTitle: "Studio — OpenClaw")
        let window = try #require(controller._testWindow)

        #expect(window.styleMask.contains(.fullSizeContentView))
        #expect(window.titleVisibility == .hidden)
        #expect(window.titlebarAppearsTransparent)
        #expect(window.toolbarStyle == .unified)
        #expect(window.titlebarSeparatorStyle == .none)
        #expect(window.isMovableByWindowBackground)
        #expect(window.isRestorable == false)
        #expect(window.title == "Studio — OpenClaw")
        window.title = "main"
        #expect(window.title == "Studio — OpenClaw")
        #expect(controller._testSceneBridgingOptions?.contains(.toolbars) == true)
        #expect(controller._testSceneBridgingOptions?.contains(.title) == false)

        controller.show()
        #expect(window.titleVisibility == .hidden)
        #expect(window.toolbar != nil)
        controller.close()
    }

    @Test func `closing a full window releases it and notifies its owner once`() {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            transport: TestTransport())
        var closeCount = 0
        var visibilityChanges: [Bool] = []
        controller.onVisibilityChanged = { visibilityChanges.append($0) }
        controller.onClosed = { closeCount += 1 }

        controller.close()
        controller.close()

        #expect(controller._testWindow == nil)
        #expect(closeCount == 1)
        #expect(visibilityChanges == [false])
    }

    @Test func `one Gateway profile can own multiple independent windows`() async throws {
        try await withIsolatedWebChatProfile { manager, profile in
            try await manager.show(profile: profile)
            try await manager.show(profile: profile)
            let connection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)

            #expect(manager._testProfileWindowCount(profileID: profile.id) == 2)
            #expect(manager._testSessionObserverVisible(connection: connection))
            manager.resetPrimaryConnections()
            #expect(manager._testProfileWindowCount(profileID: profile.id) == 2)
            #expect(manager._testSessionObserverVisible(connection: connection))
            manager.closeGatewayWindows(profileID: profile.id)
            #expect(manager._testProfileWindowCount(profileID: profile.id) == 0)
            #expect(!manager._testSessionObserverVisible(connection: connection))
        }
    }

    @Test func `closing chat retires a profile window still waiting for its connection`() async throws {
        try await withIsolatedWebChatProfile { manager, profile in
            let fleet = MacGatewayConnectionFleet.shared
            let release = DispatchSemaphore(value: 0)
            let gateEntered = AsyncStream.makeStream(of: Void.self)
            let blockedFleet = Task.detached {
                await fleet.holdForPendingWindowRegression(
                    entered: gateEntered.continuation,
                    release: release)
            }
            defer { release.signal() }
            var gateIterator = gateEntered.stream.makeAsyncIterator()
            await gateIterator.next()

            let openStarted = AsyncStream.makeStream(of: Void.self)
            let pendingOpen = Task { @MainActor in
                openStarted.continuation.yield()
                openStarted.continuation.finish()
                try await manager.show(profile: profile)
            }
            var openIterator = openStarted.stream.makeAsyncIterator()
            await openIterator.next()
            #expect(manager._testProfileWindowCount(profileID: profile.id) == 0)
            manager.close()
            release.signal()
            #expect(await blockedFleet.value)

            if case let .failure(error) = await pendingOpen.result, !(error is CancellationError) {
                Issue.record("Pending window failed unexpectedly: \(error)")
            }
            #expect(manager._testProfileWindowCount(profileID: profile.id) == 0)
            manager.closeGatewayWindows(profileID: profile.id)
        }
    }

    @Test func `initial draft populates an empty composer without replacing user text`() {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            initialDraft: "Wake up, my friend!",
            transport: TestTransport())

        #expect(controller.viewModel.input == "Wake up, my friend!")
        controller.applyDraftIfEmpty("replacement")
        #expect(controller.viewModel.input == "Wake up, my friend!")
        controller.close()
    }

    @Test func `controller explicit agent wins and nil falls back to cached default`() {
        #expect(WebChatSwiftUIWindowController.effectiveAgentID(
            explicitAgentID: " Work ", cachedDefaultAgentID: "main") == "work")
        #expect(WebChatSwiftUIWindowController.effectiveAgentID(
            explicitAgentID: nil, cachedDefaultAgentID: "main") == "main")
        #expect(WebChatSwiftUIWindowController.effectiveAgentID(
            explicitAgentID: "  ", cachedDefaultAgentID: " MAIN ") == "main")
    }

    @Test func `controller refuses cached display default when gateway requires selection`() throws {
        let cachedIdentity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "main",
            defaultAgentID: "main",
            selectionRequired: true,
            sessionRoutingContract: "opaque-routing-contract-v2"))
        let unresolved = WebChatSwiftUIWindowController(
            sessionKey: "main",
            agentID: nil,
            initialDraft: "keep this draft",
            cachedRoutingIdentity: cachedIdentity,
            store: nil)
        let explicit = WebChatSwiftUIWindowController(
            sessionKey: "main",
            agentID: " Work ",
            cachedRoutingIdentity: cachedIdentity,
            store: nil)
        var publishedSessionKeys: [String] = []
        unresolved.onSessionKeyChanged = { publishedSessionKeys.append($0) }

        #expect(unresolved.viewModel.activeAgentId == nil)
        #expect(unresolved.viewModel.requiresExplicitAgentSelection)
        unresolved._testSelectAgent(" Work ")
        #expect(!unresolved.viewModel.requiresExplicitAgentSelection)
        #expect(unresolved.viewModel.sessionKey == "agent:work:main")
        #expect(unresolved.viewModel.input == "keep this draft")
        unresolved._testSelectAgent("Research")
        #expect(unresolved.viewModel.sessionKey == "agent:research:main")
        #expect(unresolved._testSelectedAgentID == "research")
        #expect(unresolved.viewModel.input == "keep this draft")
        #expect(publishedSessionKeys == ["agent:work:main", "agent:research:main"])
        #expect(explicit.viewModel.activeAgentId == "work")
        unresolved.close()
        explicit.close()
    }

    @Test func `controller gates an uncached bare session until routing metadata arrives`() {
        let unresolved = WebChatSwiftUIWindowController(
            sessionKey: "main",
            agentID: nil,
            cachedRoutingIdentity: nil,
            store: nil)
        let scoped = WebChatSwiftUIWindowController(
            sessionKey: "agent:work:main",
            agentID: nil,
            cachedRoutingIdentity: nil,
            store: nil)
        let explicit = WebChatSwiftUIWindowController(
            sessionKey: "main",
            agentID: "work",
            cachedRoutingIdentity: nil,
            store: nil)

        #expect(unresolved.viewModel.requiresExplicitAgentSelection)
        #expect(!scoped.viewModel.requiresExplicitAgentSelection)
        #expect(!explicit.viewModel.requiresExplicitAgentSelection)
        unresolved.close()
        scoped.close()
        explicit.close()
    }

    @Test func `uncached selection waits for authoritative routing metadata`() throws {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            agentID: nil,
            initialDraft: "keep this draft",
            cachedRoutingIdentity: nil,
            store: nil)
        controller._testSelectAgent("work")

        #expect(controller._testSelectedAgentID == nil)
        #expect(controller.viewModel.sessionKey == "main")
        #expect(controller.viewModel.requiresExplicitAgentSelection)

        let routingIdentity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "main",
            defaultAgentID: "main",
            selectionRequired: true,
            sessionRoutingContract: "per-sender|main|unowned"))

        controller._testApplyRoutingIdentity(routingIdentity)

        #expect(controller._testSelectedAgentID == nil)
        #expect(controller.viewModel.sessionKey == "main")
        #expect(controller.viewModel.requiresExplicitAgentSelection)

        controller._testSelectAgent("work")

        #expect(controller._testSelectedAgentID == "work")
        #expect(controller.viewModel.sessionKey == "agent:work:main")
        #expect(!controller.viewModel.requiresExplicitAgentSelection)
        #expect(controller.viewModel.input == "keep this draft")
        controller.close()
    }

    @Test func `advanced new thread adoption keeps its owner and draft across reconnect`() async throws {
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "main",
            defaultAgentID: "main",
            selectionRequired: true,
            sessionRoutingContract: "routing-v1"))
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            transport: TestTransport(),
            initialRoutingIdentity: identity,
            initialAgentSelectionRequired: true)
        defer { controller.close() }
        var publishedOwners: [String] = []
        var publishedKeys: [String] = []
        controller.onAgentIDChanged = { publishedOwners.append($0) }
        controller.onSessionKeyChanged = { publishedKeys.append($0) }
        controller._testSelectAgent("research")
        #expect(controller._testSelectedAgentID == "research")

        // Use the leased creation path from New Thread Options, including adoption
        // and the controller callback, rather than directly setting the session key.
        let viewModel = controller.viewModel
        let lease = try await viewModel.newSessionRouteLease()
        #expect(await viewModel.startNewSession(
            agentID: "ops",
            worktree: false,
            worktreeBaseRef: nil,
            using: lease))
        let createdKey = viewModel.sessionKey
        #expect(createdKey.hasPrefix("agent:ops:ios-"))
        #expect(controller._testSelectedAgentID == "ops")
        #expect(publishedOwners == ["research", "ops"])
        viewModel.input = "draft for ops"

        let refreshed = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "daily",
            defaultAgentID: "research",
            selectionRequired: true,
            sessionRoutingContract: "routing-v2"))
        controller._testApplyRoutingIdentity(refreshed)

        #expect(viewModel.sessionKey == createdKey)
        #expect(viewModel.input == "draft for ops")
        #expect(viewModel.activeAgentId == "ops")
        #expect(viewModel.sessionRoutingContract == "routing-v2")
        #expect(!viewModel.requiresExplicitAgentSelection)
        #expect(controller._testSelectedAgentID == "ops")
        #expect(publishedKeys == ["agent:research:main", createdKey])
        #expect(publishedOwners == ["research", "ops"])
    }

    @Test(arguments: [false, true])
    func `canonical owner survives metadata refresh without a banner selection`(withAttachment: Bool) throws {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "agent:ops:thread",
            initialDraft: "owned draft",
            transport: TestTransport(),
            initialActiveAgentID: "research",
            explicitAgentID: "research")
        defer { controller.close() }
        let attachment = OpenClawPendingAttachment(
            url: nil,
            data: Data("owned attachment".utf8),
            fileName: "context.txt",
            mimeType: "text/plain",
            preview: nil)
        if withAttachment { controller.viewModel.attachments = [attachment] }
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "main",
            defaultAgentID: "research",
            selectionRequired: true,
            sessionRoutingContract: "routing-v2"))

        controller._testApplyRoutingIdentity(identity)

        #expect(controller.viewModel.sessionKey == "agent:ops:thread")
        #expect(controller._testSelectedAgentID == "ops")
        #expect(controller.viewModel.activeAgentId == "ops")
        #expect(controller.viewModel.input == "owned draft")
        #expect(controller.viewModel.attachments.map(\.id) == (withAttachment ? [attachment.id] : []))
        if withAttachment { controller.viewModel.removeAttachment(attachment.id) }
        #expect(controller.viewModel.sessionRoutingContract == "routing-v2")
        #expect(controller.viewModel.sessionKey == "agent:ops:thread")
        #expect(controller.viewModel.input == "owned draft")
    }

    @Test func `max and Ultra thinking preferences survive reopen`() throws {
        let suiteName = "WebChatSwiftUISmokeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        for level in ["max", "ultra"] {
            defaults.set(level, forKey: "openclaw.webchat.thinkingLevel")
            #expect(WebChatSwiftUIWindowController.persistedThinkingLevel(defaults: defaults) == level)
        }
    }

    @Test func `verbosity preference survives reopen`() throws {
        let suiteName = "WebChatSwiftUISmokeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set("full", forKey: "openclaw.webchat.verboseLevel")
        #expect(WebChatSwiftUIWindowController.persistedVerboseLevel(defaults: defaults) == "full")
        defaults.set("invalid", forKey: "openclaw.webchat.verboseLevel")
        #expect(WebChatSwiftUIWindowController.persistedVerboseLevel(defaults: defaults) == nil)
    }

    @Test func `inherited verbosity preference clears persisted override`() throws {
        let suiteName = "WebChatSwiftUISmokeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        WebChatSwiftUIWindowController.persistVerbosePreference("full", defaults: defaults)
        WebChatSwiftUIWindowController.persistVerbosePreference(nil, defaults: defaults)

        #expect(WebChatSwiftUIWindowController.persistedVerboseLevel(defaults: defaults) == nil)
        #expect(defaults.object(forKey: "openclaw.webchat.verboseLevel") == nil)
    }
}

extension MacGatewayConnectionFleet {
    fileprivate func holdForPendingWindowRegression(
        entered: AsyncStream<Void>.Continuation,
        release: DispatchSemaphore) -> Bool
    {
        // Hold the actual fleet admission boundary so close runs after show
        // starts but before it can acquire its connection.
        entered.yield()
        entered.finish()
        return release.wait(timeout: .now() + 5) == .success
    }
}
