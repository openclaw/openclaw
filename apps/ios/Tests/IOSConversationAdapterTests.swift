import Foundation
import SwiftUI
import Testing
import UIKit
import WebKit
@testable import OpenClaw
@testable import OpenClawChatUI
@testable import OpenClawKit

@MainActor
struct IOSConversationAdapterTests {
    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["OPENCLAW_IOS_PRODUCTION_CONVERSATION_URL"] != nil,
            "Requires the isolated production Gateway and shipped web assets"),
        .timeLimit(.minutes(1)))
    func `production private entry restores canonical chat before native ready and state`() async throws {
        let environment = ProcessInfo.processInfo.environment
        let root = try #require(environment["OPENCLAW_IOS_PRODUCTION_CONVERSATION_URL"].flatMap(URL.init(string:)))
        try #require(root.host == "127.0.0.1" && root.scheme == "http")
        let token = try #require(environment["OPENCLAW_IOS_PRODUCTION_CONVERSATION_TOKEN"])
        let entry = try #require(NativeConversationRoute.documentURL(
            sessionKey: "agent:main:main", agentID: "main", draft: "Appearance fixture draft", baseURL: root))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive })
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1180, height: 820)
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        let store = WKWebsiteDataStore.nonPersistent()
        var previousDocument: String?
        for remount in [false, true] {
            let fixture = try await ConversationFixture.startProduction(
                root: root, entry: entry, token: token, store: store)
            { webView in
                webView.overrideUserInterfaceStyle = .light
                controller.view = webView
                controller.view.layoutIfNeeded()
            }
            defer { fixture.stop() }
            #expect(fixture.webView.window === window)
            // Shipped auth/bootstrap must restore /chat and perform its own handshake.
            #expect(fixture.webView.url?.path == root.appendingPathComponent("chat/main").path)
            var failed = false
            fixture.bridge.onFailure = { failed = true }
            try await fixture.wait { fixture.bridge.ready && fixture.bridge.state?.connection == .connected || failed }
            try #require(fixture.bridge.ready, "Production ready was rejected after protected entry restored /chat")
            #expect(!failed)
            #expect(fixture.bridge.state?.context.sessionKey == "agent:main:main")
            #expect(fixture.bridge.state?.connection == .connected)
            let document = try #require(fixture.bridge.documentID)
            #expect(document != previousDocument)
            previousDocument = document
            for (mode, style) in [("light", UIUserInterfaceStyle.light), ("dark", .dark), ("light", .light)] {
                fixture.webView.overrideUserInterfaceStyle = style
                let palette = try #require(OpenClawSidebarPalette.conversationTheme[mode])
                let primary = try #require(palette["primary"])
                try await TestWait.state("production composer and native mode \(mode), remount=\(remount)") {
                    guard fixture.webView.traitCollection.userInterfaceStyle == style else { return false }
                    return try await fixture.webView.callAsyncJavaScript(
                        """
                        const pane = [...document.querySelectorAll('openclaw-chat-pane')].find(p => p.active);
                        const editor = [...(pane?.querySelectorAll('.cm-content, textarea') ?? [])]
                          .some(el => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0);
                        const send = pane?.querySelector('.chat-send-btn--send');
                        const fill = 'rgb(' + [1,3,5].map(i => parseInt(primary.slice(i,i+2),16)).join(', ') + ')';
                        return pane?.composerReady && editor && document.documentElement.dataset.themeMode === mode &&
                          matchMedia('(prefers-color-scheme: light)').matches === (mode === 'light') &&
                          send && !send.disabled && getComputedStyle(send).backgroundColor === fill;
                        """,
                        arguments: ["mode": mode, "primary": primary],
                        in: nil,
                        contentWorld: .page) as? Bool == true
                }
                let rendered = try #require(try await fixture.webView.callAsyncJavaScript(
                    """
                    const pane = [...document.querySelectorAll('openclaw-chat-pane')].find(p => p.active);
                    const composer = pane.querySelector('.agent-chat__input');
                    const visible = el => el && el.getBoundingClientRect().width > 0 &&
                      el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility === 'visible';
                    const editor = [...pane.querySelectorAll('.cm-content, textarea')].find(visible);
                    const background = pane.querySelector('openclaw-session-background');
                    const send = pane.querySelector('.chat-send-btn--send');
                    if (![composer, editor, send].every(visible) || !background) return null;
                    const css = el => getComputedStyle(el);
                    const rgb = hex => 'rgb(' + [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)).join(', ') + ')';
                    const root = document.documentElement;
                    const sans = el => {
                      const family = css(el).fontFamily.toLowerCase();
                      return family.includes('sans-serif') &&
                        !family.split(',').some(f =>
                          /^(serif|lora|fraunces|georgia|times.*)$/.test(f.trim().replace(/['"]/g,'')));
                    };
                    return {
                      canvas: root.dataset.themeId === 'custom' &&
                        css(document.body).backgroundColor === rgb(palette.background),
                      composer: css(composer).backgroundColor === rgb(palette.background) &&
                        css(composer).backgroundImage === 'linear-gradient(' + rgb(palette.popover) + ', ' +
                          rgb(palette.popover) + '), none',
                      accent: css(root).getPropertyValue('--accent').trim() === palette.accent &&
                        !send.disabled && css(send).backgroundColor === rgb(palette.primary),
                      sans: sans(document.body) && sans(editor),
                      noArtwork: background.hidden && css(background).display === 'none' &&
                        !background.hasAttribute('data-painted') &&
                        !background.querySelector('.session-background__image') &&
                        css(root).getPropertyValue('--app-background-image').trim() === 'none'
                    };
                    """,
                    arguments: ["palette": palette],
                    in: nil,
                    contentWorld: .page) as? [String: Bool])
                #expect(rendered["canvas"] == true)
                #expect(rendered["composer"] == true)
                #expect(rendered["accent"] == true)
                #expect(rendered["sans"] == true)
                #expect(rendered["noArtwork"] == true)
            }
            #expect(await fixture.bridge.request(.focusComposer))
        }
    }

    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["OPENCLAW_IOS_CONVERSATION_CONTROL_URL"] != nil,
            "Requires the isolated production conversation fixture"),
        .timeLimit(.minutes(3)))
    func `production native initial input`() async throws {
        try await self.checkNativeConversation(ProductionConversationProbe(), historyActive: false)
    }

    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["OPENCLAW_IOS_CONVERSATION_CONTROL_URL"] != nil,
            "Requires the isolated production conversation fixture"),
        .timeLimit(.minutes(3)))
    func `production native history active input`() async throws {
        try await self.checkNativeConversation(ProductionConversationProbe(), historyActive: true)
    }

    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["OPENCLAW_IOS_CONVERSATION_CONTROL_URL"] != nil,
            "Requires the isolated production conversation fixture"),
        .timeLimit(.minutes(3)))
    func `production WK initial input`() async throws {
        try await self.checkWebConversation(ProductionConversationProbe(), historyActive: false)
    }

    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["OPENCLAW_IOS_CONVERSATION_CONTROL_URL"] != nil,
            "Requires the isolated production conversation fixture"),
        .timeLimit(.minutes(3)))
    func `production WK history active input`() async throws {
        try await self.checkWebConversation(ProductionConversationProbe(), historyActive: true)
    }

    @Test func `provider evidence requires complete user text and same message PNG`() throws {
        let text = "PNG draft preserved while active"
        let png = try #require(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
        let image: [String: Any] = [
            "type": "input_image", "image_url": "data:image/png;base64," + png.base64EncodedString(),
        ]
        let envelope = """
        [Tue 2026-11-17 16:34 MDT] Conversation info: ⟦openclaw:ctx⟧
        ```json
        {"sender":{"id":"gateway-owner","name":"Synthetic iPad operator"}}
        ```
        """ + "\n\n"
        func message(_ parts: [[String: Any]], role: String = "user") -> [String: Any] {
            ["type": "message", "role": role, "content": parts]
        }
        func part(_ value: String) -> [String: Any] {
            ["type": "input_text", "text": value]
        }
        func request(_ input: [[String: Any]]) -> ProductionConversationProbe.Request {
            .init(id: 1, input: input, released: false, closed: false)
        }
        // Exact single-PNG note emitted by src/auto-reply/media-note.ts on this fixture path.
        let media = "[media attached: /fixture/media/inbound/openclaw-staged-" +
            "00000000-0000-4000-8000-000000000001/input-pixel---00000000-0000-4000-8000-000000000002.png" +
            " (image/png) | media://inbound/pixel---00000000-0000-4000-8000-000000000002.png \"pixel.png\"]\n"
        for value in [
            text,
            "[Tue 2026-11-17 16:34 MDT] " + text,
            envelope + text,
            media + text,
            envelope + media + text,
        ] {
            let raw = [message([part(value), image])]
            let evidence = request(raw)
            #expect(evidence.texts == [text])
            #expect(evidence.hasImageTurn(text: text, png: png))
            // Interpretation must not mutate the retained provider payload.
            let retained = try #require(evidence.input.first?["content"] as? [[String: Any]])
            #expect(retained.first?["text"] as? String == value)
        }
        for value in [
            "prefix " + text, text + " suffix", text + "\nextra user text",
            "[not a timestamp] " + text,
            envelope.replacingOccurrences(of: "```json", with: "```text") + text,
            envelope.replacingOccurrences(of: "{\"sender\":", with: "{broken:") + text,
            media + text + " suffix", media + text + "\nextra user text",
            "prefix " + media + text, media + media + text, media + "\n" + text,
            media.replacingOccurrences(of: "(image/png)", with: "(image/jpeg)") + text,
            media.replacingOccurrences(of: "media://inbound/pixel---", with: "media://inbound/other---") + text,
            media.replacingOccurrences(of: "\"pixel.png\"", with: "\"other.png\"") + text,
            media.replacingOccurrences(of: "]\n", with: "\n") + text,
        ] {
            #expect(!request([message([part(value), image])]).hasImageTurn(text: text, png: png))
        }
        for value in [text, envelope + media + text] {
            #expect(!request([message([part(value), image], role: "assistant")]).hasImageTurn(text: text, png: png))
            #expect(!request([message([part(value)]), message([image])]).hasImageTurn(text: text, png: png))
            #expect(!request([message([part(value), image])]).hasImageTurn(text: text, png: Data([0])))
            #expect(!request([message([["type": "output_text", "text": value], image])])
                .hasImageTurn(text: text, png: png))
        }
    }

    @Test(.timeLimit(.minutes(1)))
    func `ios nested quiet output and authoritative pending state render in native cells`() async throws {
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { model.detachTransport() }
        var quiet = try #require(await OpenClawChatViewModel
            .decodeMessages([ChatSessionsCodingTests.nestedRaw(ChatSessionsCodingTests.nestedEnvelope)])
            .first)
        quiet.activity = []
        model.messages = [quiet]
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive })
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1180, height: 820)
        let host = NestedTranscriptHost(rootView: OpenClawChatView(
            viewModel: model, displayOptions: [.toolActivity], composerChrome: .clean))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        try await TestWait.state("native nested host has appeared with a collection cell") {
            host.view.layoutIfNeeded()
            return host.hasAppeared && Self.transcriptList(host.view)?.visibleCells.isEmpty == false
        }
        let list = try #require(Self.transcriptList(host.view))
        #expect(!list.visibleCells.flatMap { TranscriptToolAccessibility.nodes(in: $0) }
            .contains { TranscriptToolAccessibility.identifier(of: $0) == "chat-tool-activity-nested-call" })
        try await TranscriptToolAccessibility.requireResult(
            list,
            host: host,
            callID: "nested-call",
            title: "Knowledge Status",
            status: "Finished",
            output: "Nested success output",
            onFailure: { trace in
                // Observe only this synthetic host after exhaustion; never settle or reactivate it.
                let facts = [
                    "messages=\(model.messages.count) transcript=\(model.transcriptMessages.count) " +
                        "quietMatch=\(model.messages == [quiet]) loading=\(model.isLoading)",
                    "windowHidden=\(window.isHidden) key=\(window.isKeyWindow) " +
                        "scene=\(scene.activationState.rawValue) bounds=\(window.bounds) " +
                        "hostAttached=\(host.view.window === window) hostBounds=\(host.view.bounds)",
                    "list=\(ObjectIdentifier(list)) sections=\(list.numberOfSections) " +
                        "items=\((0..<min(list.numberOfSections, 32)).map { list.numberOfItems(inSection: $0) }) " +
                        "visible=\(list.indexPathsForVisibleItems) updates=\(list.hasUncommittedUpdates)",
                    "traceCappedAt32=\(trace.count == 32)",
                ] + trace
                TranscriptToolAccessibility.recordFailure(trace: facts, list: list, host: host)
            })
        var pending = quiet
        pending.content = Array(pending.content.prefix(1))
        // A matching canonical start descriptor supplies authority, not a relabeled terminal receipt.
        pending.activity = [ChatSessionsCodingTests.nestedActivity(status: "running", phase: "start")]
        model.messages = [pending]
        try await TestWait.state("native pending custom cell exposes Working without an expandable result") {
            host.view.layoutIfNeeded()
            let nodes = list.visibleCells.flatMap { TranscriptToolAccessibility.nodes(in: $0) }
            return nodes
                .contains { $0.accessibilityLabel == "Knowledge Status" && $0.accessibilityValue == "Working" } &&
                !nodes.contains { TranscriptToolAccessibility.identifier(of: $0) == "chat-tool-activity-nested-call" }
        }
    }

    private func checkNativeConversation(_ probe: ProductionConversationProbe, historyActive: Bool) async throws {
        let key = probe.sessionKey(surface: "native", historyActive: historyActive)
        if historyActive { try await probe.startActive(key) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? databases.close() }
        let gatewayID = UUID().uuidString
        defer { UserDefaults.standard.removePersistentDomain(forName: gatewayID) }
        let store = databases.store(gatewayID: gatewayID)
        let gateway = GatewayNodeSession()
        let model = try OpenClawChatViewModel(
            sessionKey: key,
            transport: IOSGatewayChatTransport(gateway: gateway, globalAgentId: "main", outboxGatewayID: gatewayID),
            activeAgentId: "main",
            sessionRoutingContract: "per-sender|main|main",
            transcriptCache: store,
            outbox: store,
            modelPickerStore: ChatModelPickerStore(defaults: #require(UserDefaults(suiteName: gatewayID))))
        defer { model.detachTransport() }
        // Match the iOS operator transport, with fresh task-scoped synthetic key material.
        // Production loopback shared-token pairing remains the authority; no host identity is read.
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "ui",
            clientDisplayName: "Synthetic iPad operator",
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: false,
            deviceAuthGatewayID: gatewayID)
        try await DeviceIdentityStore.withStateDirectory(directory.appendingPathComponent("identity")) {
            do {
                try await gateway.connect(
                    url: probe.socketURL,
                    credentials: .init(token: probe.token),
                    connectOptions: options,
                    sessionBox: nil,
                    onConnected: {},
                    onDisconnected: { _ in },
                    onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                model.load()
                try await TestWait.state("native history, health and durable outbox restoration") {
                    model.healthOK && model.hasAppliedLiveHistory && model.hasRestoredOutboxMessages
                }
                #expect(!model.usesWebConversation)
                let host = UIHostingController(rootView: OpenClawChatView(
                    viewModel: model, displayOptions: [.toolActivity], composerChrome: .clean))
                let window = try probe.window(host)
                defer { window.isHidden = true
                    window.rootViewController = nil
                }
                try await TestWait.state("native iOS List has laid out real transcript rows") {
                    host.view.layoutIfNeeded()
                    return Self.transcriptList(host.view)?.visibleCells.isEmpty == false
                }
                let list = try #require(Self.transcriptList(host.view))
                let rowCount = Self.transcriptCount(list)
                let original = model.messages
                let controlMessage = original.first { message in
                    message.role == "user" && message.content
                        .contains { $0.text == "Synthetic iPad conversation fixture" }
                }
                let control = try #require(controlMessage)
                // Positive control: observe UIKit deletion and insertion, not SwiftUI onChange.
                model.messages = original.filter { $0.id != control.id }
                try await Self.appliedTranscript(list, host: host, count: rowCount - 1)
                model.messages = original
                try await Self.appliedTranscript(list, host: host, count: rowCount)
                let visible = original.filter { !$0.content.allSatisfy { $0.type == "redacted_thinking" } }
                try #require(visible.count < original.count)
                // Carry the visible-row deletion through hidden-envelope removal. Old rowCount cannot
                // pass this barrier; reinsertion then proves UIKit applied the filtered snapshot too.
                model.messages = visible.filter { $0.id != control.id }
                try await Self.appliedTranscript(list, host: host, count: rowCount - 1)
                model.messages = visible
                try await Self.appliedTranscript(list, host: host, count: rowCount)
                #expect(Self.transcriptCount(list) == rowCount)
                for size in [CGSize(width: 1180, height: 820), CGSize(width: 820, height: 1180)] {
                    window.frame.size = size
                    host.view.frame = window.bounds
                    host.view.layoutIfNeeded()
                    // Realize scrollback/media/error rows too; valid long content has no height cap.
                    for section in 0..<list.numberOfSections {
                        for item in 0..<list.numberOfItems(inSection: section) {
                            let path = IndexPath(item: item, section: section)
                            list.scrollToItem(at: path, at: .top, animated: false)
                            try await TestWait.state("native scrollback row is realized and laid out") {
                                list.layoutIfNeeded()
                                return list.cellForItem(at: path) != nil && !list.hasUncommittedUpdates
                            }
                            let cell = try #require(list.cellForItem(at: path))
                            #expect(cell.frame.height.isFinite && cell.frame.height > 0)
                            #expect(cell.frame.width > 0 && cell.frame.width <= window.bounds.width)
                            print("iOS row: section=\(section), item=\(item), viewport=\(size), frame=\(cell.frame)")
                        }
                    }
                }
                model.messages = original
                try await Self.appliedTranscript(list, host: host, count: rowCount)
                try await TranscriptToolAccessibility.requireNestedResults(model: model, list: list, host: host)
                if !historyActive {
                    model.input = probe.startText(key)
                    let send = try #require(model.send())
                    await send.value
                }
                try await TestWait.state("native admitted active run") { model.hasBlockingRunActivity }
                let held = try await probe.heldRequest(key)
                model.input = ProductionConversationProbe.followup
                #expect(model.canSend)
                let followup = try #require(model.send())
                await followup.value
                try await TestWait.state("native followup transfers composer custody") { model.input.isEmpty }
                model.input = ProductionConversationProbe.imageText
                let attachment = OpenClawPendingAttachment(
                    url: nil,
                    data: probe.png,
                    fileName: "pixel.png",
                    mimeType: "image/png",
                    type: "image",
                    preview: nil)
                model.attachments = [attachment]
                // Existing native policy deliberately refuses busy image sends. Verify custody, not a guard bypass.
                #expect(!model.canSend && model.send() == nil)
                #expect(model.input == ProductionConversationProbe.imageText)
                #expect(model.attachments.map(\.id) == [attachment.id] && model.attachments.first?.data == probe.png)
                await model.persistComposerDraft()
                await model.composerDraftWrites?.value
                let saved = try #require(await store.loadComposerDraft(key: key))
                #expect(saved.text == ProductionConversationProbe.imageText)
                #expect(saved.attachments.map(\.attachment.data) == [probe.png])
                #expect(model.hasBlockingRunActivity)
                try await probe.requireOpen(held)
                try await probe.releaseUntilIdle(key) { !model.hasBlockingRunActivity }
                #expect(try await probe.requests(key)
                    .contains { $0.texts.contains(ProductionConversationProbe.followup) })
                #expect(model.canSend)
                let imageSend = try #require(model.send())
                await imageSend.value
                let imageRequest = try await probe.heldRequest(key, imageAfter: held.id)
                #expect(imageRequest.hasImageTurn(text: ProductionConversationProbe.imageText, png: probe.png))
                #expect(model.attachments.isEmpty)
                try await probe.releaseUntilIdle(key) { !model.hasBlockingRunActivity }
                await model.persistComposerDraft()
                await model.pendingCacheWriteTask?.value
                await gateway.disconnect()
            } catch {
                await gateway.disconnect()
                throw error
            }
        }
    }

    private static func transcriptCount(_ list: UICollectionView) -> Int {
        (0..<list.numberOfSections).reduce(0) { $0 + list.numberOfItems(inSection: $1) }
    }

    private static func appliedTranscript(
        _ list: UICollectionView, host: UIViewController, count: Int) async throws
    {
        try await TestWait.state("UIKit transcript snapshot reaches observed row count \(count)") {
            host.view.layoutIfNeeded()
            return Self.transcriptCount(list) == count && !list.hasUncommittedUpdates
        }
        // Complete UICollectionView application/layout, not merely the model change callback.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            list.performBatchUpdates(nil) { _ in continuation.resume() }
        }
        host.view.layoutIfNeeded()
        #expect(self.transcriptCount(list) == count)
    }

    private static func transcriptList(_ view: UIView) -> UICollectionView? {
        if let list = view as? UICollectionView { return list }
        return view.subviews.lazy.compactMap(Self.transcriptList).first
    }

    private func checkWebConversation(_ probe: ProductionConversationProbe, historyActive: Bool) async throws {
        let gatewayID = "production-wk-" + UUID().uuidString
        let storageID = IOSConversationController.storageID(gatewayID: gatewayID)
        var failure: (any Error)?
        do {
            try await self.checkWebConversation(probe, historyActive: historyActive, storageID: storageID)
        } catch { failure = error }
        // The inner scope stops and releases its WKWebView before either awaited cleanup.
        // Capture thrown setup/body/cancellation errors so cleanup is never deferred to a Task.
        await IOSConversationController.removeStorage(gatewayID: gatewayID)
        do {
            try await WKWebsiteDataStore.remove(forIdentifier: storageID)
        } catch {
            Issue.record(error, "Could not remove the production WK probe's private website data store")
            if failure == nil { failure = error }
        }
        if let failure {
            throw failure
        }
    }

    private func checkWebConversation(
        _ probe: ProductionConversationProbe, historyActive: Bool, storageID: UUID) async throws
    {
        let key = probe.sessionKey(surface: "wk", historyActive: historyActive)
        if historyActive { try await probe.startActive(key) }
        let entry = try #require(NativeConversationRoute.documentURL(
            sessionKey: key,
            agentID: "main",
            draft: nil,
            baseURL: probe.root))
        let host = UIViewController()
        let window = try probe.window(host)
        defer { window.isHidden = true
            window.rootViewController = nil
            host.view = nil
        }
        // Match the maintained conversation owner, not its private-browsing fallback.
        let store = WKWebsiteDataStore(forIdentifier: storageID)
        try #require(
            store.isPersistent && store.identifier == storageID,
            "Production WK input requires its own identifier-backed persistent store")
        let fixture = try await ConversationFixture.startProduction(
            root: probe.root, entry: entry, token: probe.token, store: store)
        { host.view = $0 }
        defer { fixture.stop() }
        let installedStore = fixture.webView.configuration.websiteDataStore
        try #require(
            installedStore.isPersistent && installedStore.identifier == storageID,
            "The production WKWebView must use the probe's private persistent store")
        try await TestWait.state("production WK history and composer admission") {
            fixture.bridge.ready && fixture.bridge.state?.connection == NativeConversationState.Connection.connected &&
                fixture.bridge.state?.context.sessionKey == key
        }
        for size in [CGSize(width: 1180, height: 820), CGSize(width: 820, height: 1180)] {
            window.frame.size = size
            fixture.webView.frame = window.bounds
            host.view.layoutIfNeeded()
            try await TestWait.state("WK row bodies and composer remain inside native viewport") {
                try await fixture.webView.callAsyncJavaScript(
                    """
                    const pane = [...document.querySelectorAll('openclaw-chat-pane')].find(p => p.active);
                    const composer = pane?.querySelector('.agent-chat__input');
                    if (!pane?.composerReady || !composer) return false;
                    const rect = composer.getBoundingClientRect();
                    const groups = [...pane.querySelectorAll('.chat-group.assistant')];
                    return groups.length > 0 && groups.every(group =>
                      group.querySelector('.chat-group-messages')?.textContent.trim() ||
                      group.querySelector('.chat-group-messages img')) &&
                      rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1 &&
                      rect.top >= 0 && rect.bottom <= innerHeight + 1;
                    """,
                    arguments: [:],
                    in: nil,
                    contentWorld: .page) as? Bool == true
            }
        }
        if !historyActive { try await probe.webSend(fixture.webView, text: probe.startText(key)) }
        try await TestWait.state("WK admitted active run") { fixture.bridge.state?.run.active == true }
        let held = try await probe.heldRequest(key)
        try await probe.webSend(fixture.webView, text: ProductionConversationProbe.followup)
        try await probe.webSend(fixture.webView, text: ProductionConversationProbe.imageText, image: true)
        #expect(fixture.bridge.state?.run.active == true)
        try await probe.requireOpen(held)
        let imageRequest = try await probe.releaseUntilImage(key, after: held.id)
        #expect(imageRequest.texts.contains(ProductionConversationProbe.followup))
        #expect(imageRequest.hasImageTurn(text: ProductionConversationProbe.imageText, png: probe.png))
        try await probe.releaseUntilIdle(key) { fixture.bridge.state?.run.active == false }
    }

    @Test(.timeLimit(.minutes(1)), arguments: ["/control/chat/main", "/chat/main", "/control-other/chat/main"])
    func `canonical chat remains bounded by the authenticated mount`(path: String) async throws {
        let fixture = try await ConversationFixture.start(mount: "control")
        defer { fixture.stop() }
        _ = try await fixture.webView.callAsyncJavaScript(
            "history.replaceState(null, '', path);", arguments: ["path": path], in: nil, contentWorld: .page)
        let withinMount = path == "/control/chat/main"
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}") == withinMount)
        #expect(fixture.bridge.ready == withinMount)
    }

    @Test(.timeLimit(.minutes(1)))
    func `embedded palette comes from native sidebar and follows app appearance`() async throws {
        let fixture = try await ConversationFixture.start()
        defer { fixture.stop() }
        // Detached WKWebViews do not propagate UIKit appearance changes to web media queries.
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive })
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1180, height: 820)
        let controller = UIViewController()
        controller.view = fixture.webView
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        controller.view.layoutIfNeeded()
        #expect(fixture.webView.window === window)
        let palette = try #require(try await fixture.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_EMBED__.appearance") as? [String: [String: String]])
        #expect(palette == OpenClawSidebarPalette.conversationTheme)
        for (mode, style) in [("light", UIUserInterfaceStyle.light), ("dark", .dark)] {
            let values = try #require(palette[mode])
            #expect(values.count == 19)
            #expect(values["background"] == (style == .dark ? "#000000ff" : "#fafafaff"))
            #expect(values["accent"] == (style == .dark ? "#ff6b66ff" : "#b73833ff"))
            fixture.webView.overrideUserInterfaceStyle = style
            try await TestWait.state("embedded appearance follows native interface style") {
                guard fixture.webView.traitCollection.userInterfaceStyle == style else { return false }
                return try await fixture.webView.evaluateJavaScript(
                    "matchMedia('(prefers-color-scheme: light)').matches") as? Bool == (style == .light)
            }
        }
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}"))
        let replacement = try await fixture.reopen()
        defer { replacement.stop() }
        #expect(try await replacement.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_EMBED__.appearance") as? [String: [String: String]] == palette)
    }

    @Test(.timeLimit(.minutes(1)))
    func `bridge adopts only current documents and monotonic state`() async throws {
        let fixture = try await ConversationFixture.start()
        defer { fixture.stop() }
        #expect(try await fixture.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_EMBED__.platform") as? String == "ios")
        #expect(try await fixture.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_EMBED__.surface") as? String == "conversation")
        #expect(try await fixture
            .post("{type:'ready',surface:'conversation',capabilities:['session-facts-v1']}") == true)
        #expect(fixture.bridge.ready)
        let state = "type:'state',context:{agentId:'main',sessionKey:'agent:main:fixture'}," +
            "title:'Fixture',run:{active:true},connection:'connected'"
        #expect(try await fixture.post("{\(state),revision:2}") == true)
        #expect(try await fixture.post("{\(state),revision:1}") == false)
        #expect(fixture.bridge.state?.revision == 2)
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}") == true)
        #expect(fixture.bridge.state?.revision == 2)
        #expect(try await fixture.post("{type:'session-facts',revision:1,sessions:[]}") == true)
        #expect(fixture.bridge.facts?.sessions == [])
        #expect(try await fixture.post("{\(state),revision:3}", document: "retired") == false)
        fixture.bridge.isCurrent = { false }
        #expect(try await fixture.post("{\(state),revision:3}") == false)
        #expect(fixture.bridge.state?.revision == 2)
    }

    @Test(.timeLimit(.minutes(1)))
    func `command replies and blank commit retire the executable owner`() async throws {
        let fixture = try await ConversationFixture.start()
        defer { fixture.stop() }
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}") == true)
        _ = try await fixture.webView.evaluateJavaScript("""
        window.addEventListener('openclaw:native-conversation-command', async event => {
          if (event.detail.type === 'focus-composer') {
            await window.webkit.messageHandlers.openclawConversation.postMessage({
              contract:1, documentId:'fixture', type:'command-result',
              requestId:event.detail.requestId, ok:true
            });
          }
        });
        """)
        #expect(await fixture.bridge.request(.focusComposer))
        _ = try await fixture.webView.evaluateJavaScript("""
        window.commandSeen = new Promise(resolve => window.addEventListener(
          'openclaw:native-conversation-command', () => resolve(true), {once:true}));
        void 0;
        """)
        let pending = Task { await fixture.bridge.request(.presentation(.init(visible: false, active: false))) }
        #expect(try await fixture.webView.callAsyncJavaScript(
            "return await window.commandSeen;", arguments: [:], in: nil, contentWorld: .page) as? Bool == true)
        var shutDown = false
        fixture.bridge.close { shutDown = true }
        #expect(fixture.bridge.isClosing)
        try await fixture.wait { shutDown }
        #expect(await !(pending.value))
        #expect(!fixture.bridge.ready)
        #expect(fixture.bridge.documentID == nil)
        #expect(fixture.bridge.webView == nil)
        #expect(await !(fixture.bridge.request(.focusComposer)))
    }

    @Test(.timeLimit(.minutes(1)), arguments: [nil, false, true] as [Bool?])
    func `session actions report unsupported or failed peers for native fallback`(accepted: Bool?) async throws {
        let fixture = try await ConversationFixture.start()
        defer { fixture.stop() }
        let capabilities = accepted == nil ? "[]" : "['session-actions-v1']"
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:\(capabilities)}"))
        _ = try await fixture.webView.callAsyncJavaScript(
            """
            window.sessionActions = [];
            window.addEventListener('openclaw:native-conversation-command', async event => {
              window.sessionActions.push(event.detail.type);
              await window.webkit.messageHandlers.openclawConversation.postMessage({
                contract:1, documentId:'fixture', type:'command-result',
                requestId:event.detail.requestId, ok:accepted
              });
            });
            """,
            arguments: ["accepted": accepted ?? true],
            in: nil,
            contentWorld: .page)
        let context = NativeConversationContext(agentId: "main", sessionKey: "agent:main:fixture")
        var nativePopoverPresented = false
        await ChatProTab.openChatActions(bridge: fixture.bridge, context: context) {
            nativePopoverPresented = true
        }
        #expect(nativePopoverPresented == (accepted != true))
        #expect(try await fixture.webView.evaluateJavaScript("window.sessionActions") as? [String] ==
            (accepted == nil ? [] : ["open-session-actions"]))
    }

    @Test(.timeLimit(.minutes(1)))
    func `subframes cannot adopt the conversation document`() async throws {
        let fixture = try await ConversationFixture.start()
        defer { fixture.stop() }
        let adopted = try await fixture.webView.callAsyncJavaScript(
            """
            const frame = document.createElement('iframe');
            const loaded = new Promise(resolve => frame.onload = resolve);
            frame.src = location.href;
            document.body.appendChild(frame);
            await loaded;
            const child = frame.contentWindow;
            child.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__ = {documentId:'child'};
            const reply = await child.webkit.messageHandlers.openclawConversation.postMessage({
              contract:1, documentId:'child', type:'ready', surface:'conversation', capabilities:[]
            });
            frame.remove();
            return reply.ok;
            """,
            arguments: [:],
            in: nil,
            contentWorld: .page)
        #expect(adopted as? Bool == false)
        #expect(!fixture.bridge.ready)
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}"))
    }

    @Test(.timeLimit(.minutes(1)))
    func `revoked access preserves pending web storage`() async throws {
        let fixture = try await ConversationFixture.start(access: true)
        defer { fixture.stop() }
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}"))
        _ = try await fixture.webView.callAsyncJavaScript(
            """
            const request = indexedDB.open('conversation-fixture', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('pending');
            const db = await new Promise((resolve, reject) => {
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            await new Promise((resolve, reject) => {
              const tx = db.transaction('pending', 'readwrite');
              tx.objectStore('pending').put({draft:'unsent words', outbox:['queued message']}, 'state');
              tx.oncomplete = resolve;
              tx.onerror = () => reject(tx.error);
            });
            db.close();
            return true;
            """,
            arguments: [:],
            in: nil,
            contentWorld: .page)
        var retired = false
        fixture.bridge.onFailure = { retired = true }
        fixture.admission.current = false
        fixture.coordinator.retireAccess(in: fixture.webView)
        #expect(fixture.bridge.isClosing)
        try await fixture.wait { retired }
        #expect(fixture.webView.url?.absoluteString == "about:blank")
        #expect(fixture.bridge.webView == nil)
        let reopened = try await fixture.reopen()
        defer { reopened.stop() }
        let pending = try await reopened.webView.callAsyncJavaScript(
            """
            const request = indexedDB.open('conversation-fixture', 1);
            const db = await new Promise((resolve, reject) => {
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            const value = await new Promise((resolve, reject) => {
              const read = db.transaction('pending').objectStore('pending').get('state');
              read.onsuccess = () => resolve(read.result);
              read.onerror = () => reject(read.error);
            });
            db.close();
            return value.draft + '|' + value.outbox.join(',');
            """,
            arguments: [:],
            in: nil,
            contentWorld: .page)
        #expect(pending as? String == "unsent words|queued message")
    }

    @Test(.timeLimit(.minutes(1)))
    func `gateway storage survives owner replacement and Forget leaves other gateways intact`() async throws {
        let gatewayID = "web-storage-" + UUID().uuidString
        let otherID = gatewayID + "-other"
        let fixture = try await ConversationFixture.start(
            store: WKWebsiteDataStore(forIdentifier: IOSConversationController.storageID(gatewayID: gatewayID)))
        defer { fixture.stop() }
        var failure: (any Error)?
        do {
            _ = try await fixture.webView.evaluateJavaScript("localStorage.setItem('composer', 'Kept draft')")
            let replacement = try await fixture.reopen(store: WKWebsiteDataStore(
                forIdentifier: IOSConversationController.storageID(gatewayID: gatewayID)))
            defer { replacement.stop() }
            #expect(try await replacement.webView.evaluateJavaScript(
                "localStorage.getItem('composer')") as? String == "Kept draft")
            let other = try await fixture.reopen(store: WKWebsiteDataStore(
                forIdentifier: IOSConversationController.storageID(gatewayID: otherID)))
            defer { other.stop() }
            #expect(try await other.webView.evaluateJavaScript("localStorage.getItem('composer')") is NSNull)
            _ = try await other.webView.evaluateJavaScript("localStorage.setItem('composer', 'Other draft')")
            await IOSConversationController.removeStorage(gatewayID: gatewayID)
            #expect(try await replacement.webView.evaluateJavaScript("localStorage.getItem('composer')") is NSNull)
            #expect(try await other.webView.evaluateJavaScript(
                "localStorage.getItem('composer')") as? String == "Other draft")
        } catch { failure = error }
        await IOSConversationController.removeStorage(gatewayID: gatewayID)
        await IOSConversationController.removeStorage(gatewayID: otherID)
        if let failure {
            throw failure
        }
    }

    @Test func `offline hydration retains the native draft and only installs the I pad adapter`() async throws {
        let appModel = NodeAppModel()
        let gatewayID = "conversation-adapter-test-" + UUID().uuidString
        appModel.connectedGatewayID = gatewayID
        let owner = appModel.chatPresentation
        defer {
            owner.conversation?.close()
            owner.viewModel?.detachTransport()
            appModel.voiceWake.stop()
        }
        owner.sync(appModel: appModel)
        let model = try #require(owner.viewModel)
        model.input = "Pending offline words"
        #expect(owner.conversation == nil)
        appModel.activeGatewayConnectConfig = try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.invalid/control")),
            stableID: gatewayID,
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Fixture",
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: gatewayID))
        owner.sync(appModel: appModel)
        #expect(owner.viewModel === model)
        #expect(model.input == "Pending offline words")
        #expect((owner.conversation != nil) == (UIDevice.current.userInterfaceIdiom == .pad))
        #expect(owner.conversation?.bridge == nil)
        #expect(!model.usesWebConversation)
        owner.conversation?.close()
        model.detachTransport()
        _ = await appModel.purgeChatTranscriptCache(gatewayID: gatewayID)
        await IOSConversationController.removeStorage(gatewayID: gatewayID)
    }

    @Test func `dashboard handoff retains the mount and rejects escapes`() throws {
        let root = try #require(URL(string: "https://gateway.invalid/control/"))
        func route(_ path: String, search: String = "?draft=C%2B%2B") throws -> NativeConversationDashboardRoute {
            try JSONDecoder().decode(
                NativeConversationDashboardRoute.self,
                from: JSONSerialization.data(withJSONObject: ["path": path, "search": search]))
        }
        #expect(try IOSConversationView.dashboardURL(route("/control/settings"), baseURL: root)?.absoluteString ==
            "https://gateway.invalid/control/settings?draft=C%2B%2B")
        for path in [
            "/settings",
            "/control-other/settings",
            "//foreign.invalid",
            "/control/../outside",
            "/control/%2e%2e/outside",
            "/control/%5cforeign",
            "/control/settings#fragment",
        ] {
            #expect(try IOSConversationView.dashboardURL(route(path), baseURL: root) == nil)
        }
        #expect(try IOSConversationView
            .dashboardURL(route("/control/settings", search: "?q=%GG"), baseURL: root) == nil)
    }

    @Test func `web ownership blocks native dispatch and is released for the same scope`() async throws {
        let ownership = OpenClawChatSendOwnership()
        let scope = OpenClawChatSendOwnership.Scope(sessionKey: "agent:main:fixture", agentID: "main")
        let owner = UUID()
        #expect(ownership.beginWeb(scope, owner: owner))
        defer { ownership.endWeb(scope, owner: owner) }
        let transport = IOSGatewayChatTransport(
            gateway: GatewayNodeSession(),
            globalAgentId: "main",
            conversationOwnership: ownership)
        do {
            _ = try await transport.sendMessage(
                sessionKey: "agent:main:fixture",
                agentID: nil,
                message: "fixture",
                thinking: "off",
                idempotencyKey: "fixture",
                attachments: [],
                ifCurrentRoute: nil)
            Issue.record("Web ownership must prevent native dispatch")
        } catch OpenClawChatSendOwnershipError.webOwned {
            // Rejected before touching the unconnected fixture Gateway.
        }
        #expect(!ownership.beginNative(scope))
        ownership.endWeb(scope, owner: owner)
        #expect(ownership.beginNative(scope))
        ownership.endNative(scope)
    }
}

/// Cell layout alone can finish before UIKit completes the synthetic host's appearance.
@MainActor
private final class NestedTranscriptHost: UIHostingController<OpenClawChatView> {
    private(set) var hasAppeared = false

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        self.hasAppeared = true
    }
}

@MainActor
private final class ConversationFixture: NSObject, WKNavigationDelegate {
    let server: SettingsHubHTTPFixture?
    let gatewayURL: URL
    let webView: WKWebView
    let bridge: IOSConversationBridge
    let coordinator: AuthenticatedControlUIWebViewCoordinator
    let admission = ConversationAdmission()
    private var loaded: CheckedContinuation<Void, any Error>?

    private init(
        server: SettingsHubHTTPFixture?,
        url: URL,
        gatewayURL: URL? = nil,
        store: WKWebsiteDataStore,
        cookie: HTTPCookie?,
        authScript: String? = nil)
    {
        self.server = server
        self.gatewayURL = gatewayURL ?? url
        self.bridge = IOSConversationBridge(url: url, gatewayURL: gatewayURL ?? url)
        self.bridge.isCurrent = { true }
        let admission = self.admission
        self.coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: url,
            tls: nil,
            authScript: authScript,
            conversation: self.bridge,
            accessCookie: cookie,
            accessAdmissionIsCurrent: { admission.current })
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.userContentController.addScriptMessageHandler(
            self.bridge, contentWorld: .page, name: NativeConversationContract.handlerName)
        self.coordinator.installUserScripts(in: configuration.userContentController)
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        self.coordinator.attachNativeAuthDocument(to: self.webView)
        self.webView.navigationDelegate = self
    }

    static func start(
        access: Bool = false, store: WKWebsiteDataStore = .nonPersistent(), mount: String? = nil) async throws
        -> ConversationFixture
    {
        let server = try SettingsHubHTTPFixture(body: "<html><body>Conversation fixture</body></html>")
        let serverURL = try await server.start()
        let gatewayURL = mount.map { serverURL.deletingLastPathComponent().appendingPathComponent($0) } ?? serverURL
        let url = mount == nil ? serverURL : gatewayURL.appendingPathComponent("__openclaw__/session-entry")
        let cookie = access ? HTTPCookie(properties: [
            .name: "CF_Authorization", .value: "fixture", .originURL: url, .path: "/",
            .secure: "TRUE", .expires: Date().addingTimeInterval(3600),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]) : nil
        let fixture = ConversationFixture(
            server: server, url: url, gatewayURL: gatewayURL, store: store, cookie: cookie)
        return try await fixture.load(url)
    }

    static func startProduction(
        root: URL,
        entry: URL,
        token: String,
        store: WKWebsiteDataStore,
        configure: (WKWebView) -> Void) async throws -> ConversationFixture
    {
        let config = GatewayConnectConfig(
            url: root,
            stableID: "production-boot-" + UUID().uuidString,
            tls: nil,
            token: token,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "operator",
                scopes: ["operator.admin"],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Isolated production boot",
                allowStoredDeviceAuth: false))
        let script = AuthenticatedControlUI.authUserScript(
            config: config, pageURL: entry, storedOperatorToken: nil, usesNativeNavigationChrome: true)
        let fixture = ConversationFixture(
            server: nil, url: entry, gatewayURL: root, store: store, cookie: nil, authScript: script)
        // The real chat pane defers its composer until it has a viewport.
        // Protocol-only fixtures use zero bounds; production boot must not.
        fixture.webView.frame = CGRect(x: 0, y: 0, width: 1180, height: 820)
        configure(fixture.webView)
        return try await fixture.load(entry, seedDocument: false)
    }

    func reopen(store: WKWebsiteDataStore? = nil) async throws -> ConversationFixture {
        let fixture = ConversationFixture(
            server: server,
            url: bridge.url,
            gatewayURL: self.gatewayURL,
            store: store ?? self.webView.configuration.websiteDataStore,
            cookie: nil)
        return try await fixture.load(self.bridge.url)
    }

    private func load(_ url: URL, seedDocument: Bool = true) async throws -> ConversationFixture {
        let fixture = self
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    fixture.loaded = continuation
                    fixture.webView.load(URLRequest(url: url))
                }
            } onCancel: {
                Task { @MainActor in
                    fixture.loaded?.resume(throwing: CancellationError())
                    fixture.loaded = nil
                    fixture.stop()
                }
            }
            if seedDocument {
                _ = try await fixture.webView.evaluateJavaScript(
                    "window.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__ = {documentId:'fixture'}; void 0;")
            }
            return fixture
        } catch { fixture.stop()
            throw error
        }
    }

    func post(_ fields: String, document: String = "fixture") async throws -> Bool {
        try await self.webView.callAsyncJavaScript(
            """
            const reply = await window.webkit.messageHandlers.openclawConversation.postMessage({
              contract:1, documentId:document, ...\(fields)
            });
            return reply.ok;
            """,
            arguments: ["document": document],
            in: nil,
            contentWorld: .page) as? Bool == true
    }

    func wait(_ condition: () -> Bool) async throws {
        while !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func stop() {
        self.bridge.retire()
        self.webView.stopLoading()
        self.webView.navigationDelegate = nil
        self.webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeConversationContract.handlerName, contentWorld: .page)
        self.server?.stop()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        self.coordinator.webView(webView, decidePolicyFor: action, decisionHandler: decisionHandler)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
    {
        self.coordinator.webView(webView, decidePolicyFor: response, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        self.coordinator.webView(webView, didStartProvisionalNavigation: navigation)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        self.coordinator.webView(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.coordinator.webView(webView, didFinish: navigation)
        self.loaded?.resume()
        self.loaded = nil
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: any Error) {
        self.loaded?.resume(throwing: error)
        self.loaded = nil
    }
}

@MainActor
private final class ConversationAdmission {
    var current = true
}

/// Client of the task's maintained production Gateway/provider fixture, never a protocol replacement.
@MainActor
private struct ProductionConversationProbe {
    struct Request {
        let id: Int
        let input: [[String: Any]]
        let released: Bool
        let closed: Bool

        var userParts: [[[String: Any]]] {
            self.input.filter { $0["type"] as? String == "message" && $0["role"] as? String == "user" }
                .compactMap { $0["content"] as? [[String: Any]] }
        }

        var texts: [String] {
            self.userParts.flatMap(\.self).compactMap {
                guard $0["type"] as? String == "input_text", let raw = $0["text"] as? String else { return nil }
                return Self.userText(raw)
            }
        }

        /// The display preprocessor also rewrites Markdown/body whitespace. Provider evidence
        /// instead removes only the complete generated prefix observed on this production path.
        /// Keep `input` unchanged, and compare every remaining body byte, not a marker substring.
        private static func userText(_ raw: String) -> String? {
            var text = raw
            if let timestamp = text.range(
                of: #"^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} "# +
                    #"\d{2}:\d{2}(?::\d{2})? [A-Z]{2,5}(?:[+-]\d{1,2}(?::\d{2})?)?\] "#,
                options: .regularExpression)
            {
                text.removeSubrange(timestamp)
            }
            let prefix = "Conversation info: ⟦openclaw:ctx⟧\n```json\n"
            if text.hasPrefix(prefix) {
                let metadataStart = text.index(text.startIndex, offsetBy: prefix.count)
                guard let end = text.range(of: "\n```\n\n", range: metadataStart..<text.endIndex),
                      let metadata = try? JSONSerialization.jsonObject(
                          with: Data(text[metadataStart..<end.lowerBound].utf8)) as? [String: Any],
                      metadata["sender"] is [String: Any] else { return nil }
                text = String(text[end.upperBound...])
            }
            // No Swift owner exposes this strict provider grammar. The display preprocessor
            // changes body bytes. Accept only this fixture's complete canonical single-PNG
            // header, with the same generated basename in the staged path and media URI.
            let uuid = #"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"#
            if let media = text.range(
                of: #"^\[media attached: /[^\r\n\[\]]*/media/inbound/openclaw-staged-"# + uuid +
                    #"/input-(pixel---"# + uuid + #"\.png) \(image/png\) \| media://inbound/\1 "pixel\.png"\]\n"#,
                options: .regularExpression)
            {
                text.removeSubrange(media)
            }
            return text
        }

        func hasImageTurn(text: String, png: Data) -> Bool {
            self.userParts.contains { parts in
                parts.contains { part in
                    guard part["type"] as? String == "input_text",
                          let raw = part["text"] as? String else { return false }
                    return Self.userText(raw) == text
                } &&
                    parts.contains { part in
                        guard part["type"] as? String == "input_image",
                              let url = part["image_url"] as? String,
                              url.hasPrefix("data:image/png;base64,") else { return false }
                        return Data(base64Encoded: String(url.dropFirst("data:image/png;base64,".count))) == png
                    }
            }
        }
    }

    static let followup = "Follow-up text preserved while active"
    static let imageText = "PNG draft preserved while active"
    let root: URL
    let token: String
    let socketURL: URL
    let controlURL: URL
    let controlToken: String
    let png: Data

    init() throws {
        let env = ProcessInfo.processInfo.environment
        self.root = try #require(env["OPENCLAW_IOS_PRODUCTION_CONVERSATION_URL"].flatMap(URL.init(string:)))
        self.controlURL = try #require(env["OPENCLAW_IOS_CONVERSATION_CONTROL_URL"].flatMap(URL.init(string:)))
        for url in [self.root, self.controlURL] {
            try #require(url.host == "127.0.0.1" && url.scheme == "http")
        }
        self.token = try #require(env["OPENCLAW_IOS_PRODUCTION_CONVERSATION_TOKEN"])
        self.controlToken = try #require(env["OPENCLAW_IOS_CONVERSATION_CONTROL_TOKEN"])
        var components = try #require(URLComponents(url: self.root, resolvingAgainstBaseURL: false))
        components.scheme = "ws"
        self.socketURL = try #require(components.url)
        self.png = try #require(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
    }

    func sessionKey(surface: String, historyActive: Bool) -> String {
        "agent:main:ipad-\(surface)-\(historyActive ? "active" : "initial")"
    }

    func startText(_ key: String) -> String {
        "Start synthetic conversation \(key)"
    }

    func window(_ controller: UIViewController) throws -> UIWindow {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive })
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1180, height: 820)
        window.rootViewController = controller
        // Layout proof does not steal the key window or claim trusted touch/keyboard proof.
        window.isHidden = false
        return window
    }

    private func control(_ path: String, post: Bool = false) async throws -> [String: Any] {
        let url = try #require(URL(string: path, relativeTo: self.controlURL))
        var request = URLRequest(url: url)
        request.httpMethod = post ? "POST" : "GET"
        request.setValue(self.controlToken, forHTTPHeaderField: "x-fixture-token")
        let (data, response) = try await URLSession.shared.data(for: request)
        try #require((response as? HTTPURLResponse)?.statusCode == 200)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func startActive(_ key: String) async throws {
        _ = try await self.control("/start-active?sessionKey=\(key)", post: true)
    }

    func requests(_ key: String) async throws -> [Request] {
        let status = try await self.control("/status")
        return try #require(status["requests"] as? [[String: Any]]).compactMap { row in
            let body = try #require(row["body"] as? [String: Any])
            let request = try Request(
                id: #require(row["id"] as? Int),
                input: #require(body["input"] as? [[String: Any]]),
                released: #require(row["released"] as? Bool),
                closed: #require(row["closed"] as? Bool))
            // Correlate complete user text after its structured generated envelope, never arbitrary JSON fields.
            return request.texts.contains(self.startText(key)) ? request : nil
        }
    }

    func heldRequest(_ key: String, imageAfter requestID: Int? = nil) async throws -> Request {
        var found: Request?
        try await TestWait.state("held provider request for correlated session and exact input parts") {
            found = try await self.requests(key).first { row in
                guard !row.released, !row.closed else { return false }
                guard let requestID else { return true }
                return row.id > requestID && row.hasImageTurn(text: Self.imageText, png: self.png)
            }
            return found != nil
        }
        return try #require(found)
    }

    func requireOpen(_ held: Request) async throws {
        let rows = try #require(try await self.control("/status")["requests"] as? [[String: Any]])
        let row = try #require(rows.first { $0["id"] as? Int == held.id })
        #expect(row["released"] as? Bool == false && row["closed"] as? Bool == false)
    }

    func releaseUntilIdle(_ key: String, idle: () -> Bool) async throws {
        try await TestWait.state("production active run finishes after explicit provider release") {
            for row in try await self.requests(key) where !row.closed && !row.released {
                _ = try await self.control("/release?id=\(row.id)", post: true)
            }
            return idle()
        }
    }

    func releaseUntilImage(_ key: String, after requestID: Int) async throws -> Request {
        var image: Request?
        try await TestWait.state("accepted WK pending input reaches provider with exact PNG bytes") {
            for row in try await self.requests(key) where !row.closed && !row.released {
                if row.id > requestID, row.hasImageTurn(text: Self.imageText, png: self.png) { image = row
                    return true
                }
                _ = try await self.control("/release?id=\(row.id)", post: true)
            }
            return false
        }
        return try #require(image)
    }

    func webSend(_ webView: WKWebView, text: String, image: Bool = false) async throws {
        // Synthetic DOM input exercises shipped WK handlers, not trusted tap or the photo picker.
        _ = try await webView.callAsyncJavaScript(
            """
            const pane = [...document.querySelectorAll('openclaw-chat-pane')].find(p => p.active);
            const editor = [...pane.querySelectorAll('.cm-content, textarea')]
              .find(el => el.getBoundingClientRect().height > 0);
            editor.focus();
            if (editor instanceof HTMLTextAreaElement) {
              editor.value = text; editor.dispatchEvent(new Event('input', {bubbles:true}));
            } else { document.execCommand('insertText', false, text); }
            if (image) {
              const transfer = new DataTransfer();
              const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
              transfer.items.add(new File([bytes], 'pixel.png', {type:'image/png'}));
              const input = pane.querySelector('.agent-chat__file-input');
              input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));
            }
            return true;
            """,
            arguments: ["text": text, "image": image, "png": self.png.base64EncodedString()],
            in: nil,
            contentWorld: .page)
        try await TestWait.state("WK send enabled after complete text and attachment staging") {
            try await webView.callAsyncJavaScript(
                """
                const pane = [...document.querySelectorAll('openclaw-chat-pane')].find(p => p.active);
                const send = pane?.querySelector('.chat-send-btn--send');
                return Boolean(send && !send.disabled && (!image || pane.querySelector('.chat-attachment-thumb')));
                """,
                arguments: ["image": image],
                in: nil,
                contentWorld: .page) as? Bool == true
        }
        _ = try await webView.callAsyncJavaScript(
            "document.querySelector('.chat-pane-cache__pane--visible .chat-send-btn--send').click(); return true;",
            arguments: [:],
            in: nil,
            contentWorld: .page)
        try await TestWait.state("WK accepted draft leaves composer only after owned send") {
            try await webView.callAsyncJavaScript(
                """
                const pane = [...document.querySelectorAll('openclaw-chat-pane')].find(p => p.active);
                const editor = pane.querySelector('.cm-content, textarea');
                return !(editor.value ?? editor.textContent).trim() &&
                  !pane.querySelector('.chat-attachment-thumb');
                """,
                arguments: [:],
                in: nil,
                contentWorld: .page) as? Bool == true
        }
    }
}
