import Foundation
import GRDB
import OpenClawKit
import SwiftUI
import Synchronization
import Testing
import UIKit
import WebKit
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
@Suite(.enabled { await MainActor.run { UIDevice.current.userInterfaceIdiom == .pad } }, .timeLimit(.minutes(1)))
struct IOSConversationControllerTests {
    @Test func `tab remount opens the selected web thread instead of the original document`() async throws {
        let server = try SettingsHubHTTPFixture(body: """
        <html><body><script>
        const documentId = crypto.randomUUID();
        window.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__ = { documentId };
        const path = new URL(location.href).searchParams.get('path');
        history.replaceState(null, '', path);
        let revision = 0;
        const post = body => window.webkit.messageHandlers.openclawConversation.postMessage({
          contract: 1, documentId, ...body
        });
        window.selectFixtureSession = sessionKey => post({
          type: 'state', revision: ++revision, context: {agentId: 'main', sessionKey},
          title: sessionKey, run: {active: false}, connection: 'connected'
        });
        window.addEventListener('openclaw:native-conversation-command', async ({detail}) => {
          const reply = detail.type === 'navigate'
            ? await window.selectFixtureSession(detail.payload.sessionKey) : {ok: true};
          await post({type: 'command-result', requestId: detail.requestId, ok: reply.ok === true});
        });
        post({type: 'ready', surface: 'conversation', capabilities: []}).then(() =>
          window.selectFixtureSession(path.endsWith('/selected') ? 'agent:main:selected' : 'agent:main:origin'));
        </script></body></html>
        """)
        let root = try await server.start()
        defer { server.stop() }
        try await ControllerFixture
            .run(sessionKey: "agent:main:origin", url: root.deletingLastPathComponent()) { fixture in
                let selected = NativeConversationContext(agentId: "main", sessionKey: "agent:main:selected")
                fixture.appModel.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
                fixture.controller.reconcile()
                try await TestWait.observed("initial conversation bridge") { fixture.controller.bridge != nil }
                let original = try #require(fixture.controller.bridge)
                var events: [String] = []
                @MainActor func observeLifecycle(
                    _ bridge: IOSConversationBridge, label: String) -> @MainActor () -> Void
                {
                    let failure = bridge.onFailure
                    let dismantle = bridge.onDismantle
                    bridge.onFailure = {
                        if events.count < 8 { events.append(label + ".failure") }
                        failure?()
                    }
                    bridge.onDismantle = {
                        if events.count < 8 { events.append(label + ".dismantle") }
                        dismantle?()
                    }
                    return {
                        bridge.onFailure = failure
                        bridge.onDismantle = dismantle
                    }
                }
                let restoreOriginal = observeLifecycle(original, label: "original")
                defer { restoreOriginal() }
                let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                    .first { $0.activationState == .foregroundActive })
                let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
                let window = UIWindow(windowScene: scene)
                let chat = AnyView(IOSConversationView(controller: fixture.controller).environment(fixture.appModel))
                let host = UIHostingController(rootView: chat)
                window.rootViewController = host
                window.makeKeyAndVisible()
                defer {
                    window.isHidden = true
                    window.rootViewController = nil
                    previousKeyWindow?.makeKeyAndVisible()
                }
                var stage = "A handshake"
                var replyOK = "not-returned"
                var replyError = ""
                // One bounded synthetic snapshot also survives thrown requirements/cancellation,
                // before window teardown can dismantle the document being diagnosed.
                defer {
                    fixture.recordRemountDiagnostic(
                        original: original, stage: stage, replyOK: replyOK, replyError: replyError, events: events)
                }
                try await TestWait.observed("A admitted by the real WebKit handshake") {
                    original.ready && fixture.controller.owner.state?.context.sessionKey == "agent:main:origin"
                }
                let originalDocument = try #require(original.documentID)
                let webView = try #require(original.webView)
                stage = "B bridge reply"
                let reply = try #require(try await webView.callAsyncJavaScript(
                    "return await window.selectFixtureSession(sessionKey);",
                    arguments: ["sessionKey": selected.sessionKey],
                    in: nil,
                    contentWorld: .page) as? [String: Any])
                replyOK = String(describing: reply["ok"] as? Bool)
                replyError = String((reply["error"] as? String ?? "").prefix(256))
                try #require(reply["ok"] as? Bool == true, "B bridge rejected state: \(replyError)")
                stage = "B bridge state"
                try await TestWait.observed("original bridge accepted B state") { original.state?.context == selected }
                stage = "B owner state"
                try await TestWait.observed("controller owner admitted B state") {
                    fixture.controller.owner.state?.context == selected
                }
                stage = "B native model selection"
                try await TestWait
                    .observed("native model selected B") { fixture.model.sessionKey == selected.sessionKey }
                stage = "B combined admission"
                try await TestWait.observed("web B selected and admitted") {
                    fixture.controller.owner.state?.context == selected && fixture.model.sessionKey == selected
                        .sessionKey
                }
                stage = "Overview replacement"
                host.rootView = AnyView(Text("Overview"))
                try await TestWait.observed("replacement after leaving Chat") {
                    fixture.controller.bridge != nil && fixture.controller.bridge !== original
                }
                let replacement = try #require(fixture.controller.bridge)
                let restoreReplacement = observeLifecycle(replacement, label: "replacement")
                defer { restoreReplacement() }
                let entry = try #require(URLComponents(url: replacement.url, resolvingAgainstBaseURL: false))
                #expect(entry.queryItems == [.init(name: "path", value: "/chat/main/~key/selected")])
                #expect(fixture.controller.documentURL == replacement.url)
                #expect(original.webView == nil)
                #expect(fixture.controller.owner.state == nil)
                stage = "Chat readmission"
                host.rootView = chat
                try await TestWait.observed("new document and B admitted after returning to Chat") {
                    replacement.ready && replacement.documentID != originalDocument &&
                        fixture.controller.owner.state?.context == selected
                }
                let replacementWebView = try #require(replacement.webView)
                stage = "stale A rejection"
                let staleAccepted = try await replacementWebView.callAsyncJavaScript(
                    """
                    const reply = await window.webkit.messageHandlers.openclawConversation.postMessage({
                      contract:1, documentId:oldDocument, type:'state', revision:99,
                      context:{agentId:'main',sessionKey:'agent:main:origin'},
                      title:'Old A', run:{active:false}, connection:'connected'
                    });
                    return reply.ok;
                    """,
                    arguments: ["oldDocument": originalDocument],
                    in: nil,
                    contentWorld: .page)
                #expect(staleAccepted as? Bool == false)
                #expect(fixture.controller.bridge === replacement)
                #expect(fixture.controller.owner.state?.context == selected)
                #expect(fixture.model.sessionKey == selected.sessionKey)
                fixture.expectNativeAdmission(selected, allowed: false)
                stage = "complete"
            }
    }

    @Test(arguments: ["", "/configured"])
    func `learned mount reaches the retained offline owner before web admission`(urlPath: String) async throws {
        try await ControllerFixture.run(urlPath: urlPath) { fixture in
            let authority = fixture.appModel.activeGatewayConnectConfig?.controlUIInputs
            #expect(!fixture.appModel.isOperatorGatewayConnected)
            #expect(fixture.controller.bridge == nil)
            fixture.appModel.activeGatewayConnectConfig?.controlUiBasePath = "/learned/control"
            #expect(fixture.appModel.activeGatewayConnectConfig?.controlUIInputs == authority)
            fixture.appModel.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
            fixture.appModel.chatPresentation.sync(appModel: fixture.appModel)
            try await TestWait.observed("learned-mount bridge creation") { fixture.controller.bridge != nil }
            #expect(fixture.appModel.chatPresentation.conversation === fixture.controller)
            #expect(fixture.appModel.chatPresentation.viewModel === fixture.model)
            let bridge = try #require(fixture.controller.bridge)
            let mount = urlPath.isEmpty ? "/learned/control" : "/configured"
            #expect(bridge.url.path == mount + "/__openclaw__/session-entry")
            #expect(fixture.controller.documentURL == bridge.url)
            let entry = try #require(URLComponents(url: bridge.url, resolvingAgainstBaseURL: false))
            #expect(entry.queryItems == [.init(name: "path", value: mount + "/chat/main")])
            // These are controller callbacks, not a replacement WebKit trust handshake.
            // IOSConversationAdapterTests separately exercise real document/mount admission.
            bridge.onReady?()
            #expect(fixture.model.usesWebConversation)
            let dashboard = try JSONDecoder().decode(
                NativeConversationDashboardRoute.self, from: Data("{\"path\":\"\(mount)/settings\"}".utf8))
            let outside = try JSONDecoder().decode(
                NativeConversationDashboardRoute.self, from: Data("{\"path\":\"\(mount)-other/settings\"}".utf8))
            #expect(bridge.onDashboard?(dashboard) == true)
            #expect(bridge.onDashboard?(outside) == false)
            bridge.onRoute?(.init(agentId: "main", sessionKey: "agent:main:main"))
            try await TestWait.observed("learned-mount canonical route selection") {
                fixture.model.sessionKey == "agent:main:main"
            }
            fixture.expectNativeAdmission(.init(agentId: "main", sessionKey: "agent:main:main"), allowed: false)
        }
    }

    @Test func `changed learned mount retires the old bridge without replacing native ownership`() async throws {
        try await ControllerFixture.run(urlPath: "") { fixture in
            let original = try await fixture.startWeb()
            let authority = fixture.appModel.activeGatewayConnectConfig?.controlUIInputs
            fixture.appModel.activeGatewayConnectConfig?.controlUiBasePath = "/control"
            #expect(fixture.appModel.activeGatewayConnectConfig?.controlUIInputs == authority)
            fixture.appModel.chatPresentation.sync(appModel: fixture.appModel)
            try await TestWait.observed("replacement learned-mount bridge") {
                fixture.controller.bridge != nil && fixture.controller.bridge !== original
            }
            let replacement = try #require(fixture.controller.bridge)
            #expect(fixture.appModel.chatPresentation.conversation === fixture.controller)
            #expect(fixture.appModel.chatPresentation.viewModel === fixture.model)
            #expect(replacement.url.path == "/control/__openclaw__/session-entry")
            // Probing already excludes native sends; only the replacement may become ready.
            #expect(fixture.controller.owner.mode == .probing)
            original.onReady?()
            #expect(fixture.controller.owner.mode == .probing)
            replacement.onReady?()
            #expect(fixture.controller.owner.mode == .web)
            fixture.expectNativeAdmission(.init(agentId: "main", sessionKey: "main"), allowed: false)
        }
    }

    @Test(arguments: [true, false])
    func `learned mount retries failed admission but preserves explicit native controls`(
        nativeRequested: Bool) async throws
    {
        try await ControllerFixture.run(urlPath: "") { fixture in
            let bridge = try await fixture.startWeb()
            if nativeRequested {
                fixture.controller.requestNativeControls()
            } else {
                bridge.onFailure?()
            }
            #expect(fixture.controller.bridge == nil)
            fixture.appModel.activeGatewayConnectConfig?.controlUiBasePath = "/control"
            fixture.appModel.chatPresentation.sync(appModel: fixture.appModel)
            if nativeRequested {
                #expect(fixture.controller.nativeRequested)
                #expect(fixture.controller.bridge == nil)
                #expect(!fixture.model.usesWebConversation)
                fixture.controller.resumeWeb()
            }
            try await TestWait.observed("admission after learned-mount recovery") { fixture.controller.bridge != nil }
            let replacement = try #require(fixture.controller.bridge)
            #expect(replacement !== bridge)
            #expect(replacement.url.path == "/control/__openclaw__/session-entry")
            replacement.onReady?()
            #expect(fixture.model.usesWebConversation)
            #expect(fixture.appModel.chatPresentation.viewModel === fixture.model)
        }
    }

    @Test func `retiring during the final destination draft read cannot leak a web claim`() async throws {
        try await ControllerFixture.run { fixture in
            _ = try await fixture.startWeb()
            let destination = NativeConversationContext(agentId: "main", sessionKey: "agent:main:destination")
            let readEntered = AsyncTestGate()
            let releaseRead = DispatchSemaphore(value: 0)
            let reads = Mutex(0)
            let databases = fixture.store.databases
            let gatewayID = fixture.store.gatewayID
            let draftKey = fixture.model.composerSessionKey(for: destination.sessionKey, agentID: destination.agentId)
            // Hold the actual SQLite destination read, not an alternate controller check.
            // GRDB invokes this Sendable callback on its database queue, never the main actor.
            try await Task.detached {
                try await databases.stateQueue.writeWithoutTransaction { db in
                    db.trace(options: .statement) { @Sendable event in
                        guard case let .statement(statement) = event,
                              statement.sql.hasPrefix("SELECT text, revision FROM composer_drafts "),
                              statement.expandedSQL.contains("'\(gatewayID)'"),
                              statement.expandedSQL.contains("'\(draftKey)'") else { return }
                        let finalRead = reads.withLock { count in
                            count += 1
                            return count == 2
                        }
                        if finalRead {
                            readEntered.open()
                            releaseRead.wait()
                        }
                    }
                }
            }.value
            let reservation = Task { await fixture.controller.reserve(destination) }
            var admission: Task<Void, any Error>?
            var failure: (any Error)?
            do {
                try await readEntered.wait("final destination draft read")
                // The temporary reservation excludes native sends while the read is suspended.
                fixture.expectNativeAdmission(destination, allowed: false)
                let admissionBlocked = AsyncTestGate()
                let waiting = Task {
                    try await fixture.waitForNativeAdmission(destination, onBlocked: { admissionBlocked.open() })
                }
                admission = waiting
                try await admissionBlocked.wait("native admission blocked by temporary reservation")
                fixture.controller.requestNativeControls()
                #expect(fixture.controller.bridge == nil)
                #expect(!fixture.model.usesWebConversation)
                releaseRead.signal()
                let reserved = try await TestWait.value(of: reservation, "retired destination reservation")
                #expect(!reserved)
                try await TestWait.value(of: waiting, "native admission after joined reservation release")
                fixture.expectNativeAdmission(destination, allowed: true)
                fixture.expectNativeAdmission(.init(agentId: "main", sessionKey: "agent:main:main"), allowed: true)
            } catch {
                failure = error
            }
            // Unblock and join both owned tasks even when the suite cancels a wait. Clear
            // the installation-wide trace in an uncancelled task before fixture teardown.
            reservation.cancel()
            admission?.cancel()
            releaseRead.signal()
            _ = await reservation.value
            _ = await admission?.result
            try await Task.detached {
                try await databases.stateQueue.writeWithoutTransaction { db in db.trace(options: []) }
            }.value
            if let failure {
                throw failure
            }
        }
    }

    @Test(arguments: [true, false])
    func `canonical main reports unlock web thread navigation before native controls`(viaState: Bool) async throws {
        try await ControllerFixture.run { fixture in
            #expect(fixture.model.sessionKey == "main")
            let bridge = try await fixture.startWeb()
            let main = NativeConversationContext(agentId: "main", sessionKey: "agent:main:main")
            // Exercise the controller's trusted-document callbacks. Bridge admission and
            // actual about:blank retirement are covered by IOSConversationAdapterTests.
            if viaState {
                let state = try JSONDecoder().decode(NativeConversationState.self, from: Data(#"""
                {"revision":1,"context":{"agentId":"main","sessionKey":"agent:main:main"},
                 "title":"Main","run":{"active":false},"connection":"connected"}
                """#.utf8))
                bridge.onState?(state)
            } else {
                bridge.onRoute?(main)
            }
            try await TestWait.observed("canonical main selection") { fixture.model.sessionKey == "agent:main:main" }
            let thread = NativeConversationContext(agentId: "main", sessionKey: "agent:main:web-thread")
            bridge.onRoute?(thread)
            try await TestWait.observed("web thread selection") { fixture.model.sessionKey == thread.sessionKey }
            #expect(fixture.controller.bridge === bridge)
            #expect(fixture.model.usesWebConversation)
            fixture.expectNativeAdmission(thread, allowed: false)
            fixture.controller.requestNativeControls()
            #expect(!fixture.model.usesWebConversation)
            #expect(fixture.model.sessionKey == "agent:main:web-thread")
            try await fixture.waitForNativeAdmission(thread)
            fixture.expectNativeAdmission(main, allowed: true)
        }
    }

    @Test(arguments: [true, false])
    func `unavailable web destination opens its native draft or queued work instead of the old chat`(
        hasDraft: Bool) async throws
    {
        try await ControllerFixture.run(sessionKey: "agent:main:origin") { fixture in
            let destination = NativeConversationContext(agentId: "main", sessionKey: "agent:main:pending")
            let draftKey = fixture.model.composerSessionKey(for: destination.sessionKey, agentID: destination.agentId)
            if hasDraft {
                #expect(await fixture.store.saveComposerDraftText(key: draftKey, text: "Draft for B only", revision: 1))
            } else {
                #expect(await fixture.store.enqueueCommand(.init(
                    id: "queued-b",
                    sessionKey: destination.sessionKey,
                    deliverySessionKey: destination.sessionKey,
                    routingContract: "per-sender|main|main",
                    agentID: "main",
                    text: "Queued for B only",
                    thinking: "off",
                    createdAt: Date().timeIntervalSince1970,
                    status: .queued,
                    retryCount: 0,
                    lastError: nil)))
            }
            let bridge = try await fixture.startWeb()
            #expect(fixture.model.sessionKey == "agent:main:origin")
            bridge.onRoute?(.init(agentId: "main", sessionKey: "agent:main:origin"))
            bridge.onRoute?(destination)
            try await TestWait.observed("unavailable destination retirement") { fixture.controller.bridge == nil }
            await fixture.model.composerDraftSync.load?.value
            #expect(!fixture.model.usesWebConversation)
            #expect(fixture.model.sessionKey == "agent:main:pending")
            #expect(fixture.model.input == (hasDraft ? "Draft for B only" : ""))
            let commands = await fixture.store.loadCommands()
            #expect(commands.map(\.text) == (hasDraft ? [] : ["Queued for B only"]))
            #expect(commands.map(\.deliverySessionKey) == (hasDraft ? [] : ["agent:main:pending"]))
            #expect(fixture.controller.bridge == nil)
            #expect(fixture.controller.nativeRequested)
            // Concurrent destination reads may still own temporary reservations while
            // their database reads return. Join release before asserting native admission.
            try await fixture.waitForNativeAdmission(destination)
            fixture.expectNativeAdmission(.init(agentId: "main", sessionKey: "agent:main:origin"), allowed: true)
        }
    }
}

@MainActor
private struct ControllerFixture {
    let appModel: NodeAppModel
    let model: OpenClawChatViewModel
    let controller: IOSConversationController
    let store: OpenClawChatSQLiteTranscriptCache

    static func run(
        sessionKey: String = "main",
        urlPath: String = "/control",
        url: URL? = nil,
        _ body: (Self) async throws -> Void) async throws
    {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let gatewayID = "conversation-controller-" + UUID().uuidString
        let state = try TemporaryOpenClawState(instanceID: gatewayID)
        defer { state.restore() }
        let appModel = NodeAppModel()
        defer {
            appModel.chatPresentation.conversation?.close()
            appModel.chatPresentation.viewModel?.detachTransport()
            appModel.voiceWake.stop()
            appModel.disconnectGateway()
        }
        appModel.connectedGatewayID = gatewayID
        appModel.gatewayDefaultAgentId = "main"
        appModel.focusChatSession(sessionKey)
        appModel.activeGatewayConnectConfig = try GatewayConnectConfig(
            url: #require(url ?? URL(string: "wss://gateway.invalid" + urlPath)),
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
                clientDisplayName: "Controller fixture",
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: gatewayID))
        appModel.chatPresentation.sync(appModel: appModel)
        let fixture = try Self(
            appModel: appModel,
            model: #require(appModel.chatPresentation.viewModel),
            controller: #require(appModel.chatPresentation.conversation),
            store: #require(appModel.makeChatOfflineStore()))
        fixture.model.syncSessionRoutingContract("per-sender|main|main")
        await fixture.model.composerDraftSync.load?.value
        var failure: (any Error)?
        do { try await body(fixture) } catch { failure = error }
        fixture.controller.close()
        fixture.model.detachTransport()
        await fixture.model.composerDraftWrites?.value
        // The app database is installation-wide; remove only this fixture's random Gateway namespace.
        #expect(await appModel.purgeChatTranscriptCache(gatewayID: gatewayID))
        GatewaySettingsStore.saveGatewayFocusedChatSessionKey(stableID: gatewayID, sessionKey: nil)
        await IOSConversationController.removeStorage(gatewayID: gatewayID)
        if let failure {
            throw failure
        }
    }

    func startWeb() async throws -> IOSConversationBridge {
        self.appModel.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
        self.controller.reconcile()
        try await TestWait.observed("conversation bridge creation") { self.controller.bridge != nil }
        let bridge = try #require(controller.bridge)
        // No WKWebView is mounted: controller callbacks are this suite's boundary.
        // This also makes retirement immediate, deterministically rotating claimOwner.
        bridge.onReady?()
        return bridge
    }

    func recordRemountDiagnostic(
        original: IOSConversationBridge, stage: String, replyOK: String, replyError: String, events: [String])
    {
        func bridgeSnapshot(_ bridge: IOSConversationBridge?) -> [String: String] {
            guard let bridge else { return ["identity": "nil"] }
            return [
                "identity": String(describing: ObjectIdentifier(bridge)),
                "document": bridge.documentID ?? "nil",
                "ready": String(bridge.ready), "closing": String(bridge.isClosing),
                "revision": bridge.state.map { String($0.revision) } ?? "nil",
                "agent": bridge.state?.context.agentId ?? "nil",
                "session": bridge.state?.context.sessionKey ?? "nil",
                "entryURL": bridge.url.absoluteString,
                "currentURL": bridge.webView?.url?.absoluteString ?? "nil",
            ].mapValues { String($0.prefix(256)) }
        }
        let snapshot: [String: Any] = [
            "stage": stage, "BReplyOK": replyOK, "BReplyError": replyError, "events": events,
            "original": bridgeSnapshot(original), "current": bridgeSnapshot(self.controller.bridge),
            "ownerMode": String(describing: self.controller.owner.mode),
            "ownerAgent": self.controller.owner.state?.context.agentId ?? "nil",
            "ownerSession": self.controller.owner.state?.context.sessionKey ?? "nil",
            "ownerRevision": self.controller.owner.state.map { String($0.revision) } ?? "nil",
            "modelSession": self.model.sessionKey, "pendingInput": self.model.hasPendingNativeConversationInput,
            "sending": self.model.isSending, "pendingRuns": self.model.pendingRunCount,
            "blockingRun": self.model.hasBlockingRunActivity, "nativeRequested": self.controller.nativeRequested,
            "entryURL": self.controller.documentURL?.absoluteString ?? "nil",
        ]
        if let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8)
        {
            print("Controller remount diagnostic: \(text.prefix(8192))")
        }
    }

    func waitForNativeAdmission(
        _ context: NativeConversationContext, onBlocked: (() -> Void)? = nil) async throws
    {
        let scope = OpenClawChatSendOwnership.Scope(
            sessionKey: context.sessionKey,
            agentID: context.agentId,
            routingContract: self.appModel.chatSessionRoutingContract)
        // Ownership claims are NSLock-backed, not Observation storage. endWeb
        // publishes no change signal, so use the shared untracked-state wait.
        try await TestWait.state("destination reservation release") {
            let admitted = self.appModel.chatSendOwnership.beginNative(scope)
            if admitted {
                self.appModel.chatSendOwnership.endNative(scope)
            } else {
                onBlocked?()
            }
            return admitted
        }
    }

    func expectNativeAdmission(_ context: NativeConversationContext, allowed: Bool) {
        let scope = OpenClawChatSendOwnership.Scope(
            sessionKey: context.sessionKey,
            agentID: context.agentId,
            routingContract: self.appModel.chatSessionRoutingContract)
        let admitted = self.appModel.chatSendOwnership.beginNative(scope)
        #expect(admitted == allowed, "Native admission for \(context.sessionKey): expected \(allowed), got \(admitted)")
        if admitted {
            self.appModel.chatSendOwnership.endNative(scope)
        }
    }
}
