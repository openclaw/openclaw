import AppIntents
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawNativeActions
import Testing
import UIKit
@testable import OpenClaw

@Suite(.serialized) struct OpenClawAppDelegateTests {
    @Test func `live voice description is available to App Intents consumers`() {
        let intentType: any AppIntent.Type = StartLiveVoiceIntent.self
        #expect(intentType.description != nil)
    }

    @Test @MainActor func `resolves registry model before view task assigns delegate model`() {
        let registryModel = NodeAppModel()
        OpenClawAppModelRegistry.appModel = registryModel
        defer { OpenClawAppModelRegistry.appModel = nil }

        let delegate = OpenClawAppDelegate()

        #expect(delegate._test_resolvedAppModel() === registryModel)
    }

    @Test @MainActor func `prefers explicit delegate model over registry fallback`() {
        let registryModel = NodeAppModel()
        let explicitModel = NodeAppModel()
        OpenClawAppModelRegistry.appModel = registryModel
        defer { OpenClawAppModelRegistry.appModel = nil }

        let delegate = OpenClawAppDelegate()
        delegate.appModel = explicitModel

        #expect(delegate._test_resolvedAppModel() === explicitModel)
    }

    @Test @MainActor func `background refresh task is permitted and launchable from the app bundle`() throws {
        // BGTaskScheduler rejects submit with .notPermitted unless the identifier is listed
        // and the `fetch` background mode is declared; both contracts live in the app Info.plist.
        let delegate = OpenClawAppDelegate()
        let bundleIdentifier = try #require(Bundle.main.bundleIdentifier)
        let info = try #require(Bundle.main.infoDictionary)
        let identifier = delegate._test_wakeRefreshTaskIdentifier()

        #expect(identifier == "\(bundleIdentifier).bgrefresh")
        #expect(info["BGTaskSchedulerPermittedIdentifiers"] as? [String] == [identifier])
        #expect((info["UIBackgroundModes"] as? [String])?.contains("fetch") == true)
    }

    @Test @MainActor func `stages a gateway URL when the model is ready`() async throws {
        OpenClawAppModelRegistry.appModel = nil
        defer { OpenClawAppModelRegistry.appModel = nil }
        let model = NodeAppModel()
        let delegate = OpenClawAppDelegate()
        delegate.appModel = model
        let url = try #require(URL(
            string: "openclaw://gateway?host=gateway.example.com&port=443&tls=1&token=tok"))

        #expect(delegate.application(UIApplication.shared, open: url))
        let link = await Self.waitForGatewaySetup(in: model)

        #expect(link?.host == "gateway.example.com")
        #expect(link?.port == 443)
        #expect(link?.tls == true)
        #expect(link?.token == "tok")
    }

    @Test @MainActor func `replays a gateway URL received before the model is ready`() async throws {
        OpenClawAppModelRegistry.appModel = nil
        defer { OpenClawAppModelRegistry.appModel = nil }
        let delegate = OpenClawAppDelegate()
        let url = try #require(URL(
            string: "openclaw://gateway?host=gateway.example.com&port=443&tls=1&token=tok"))

        #expect(delegate.application(UIApplication.shared, open: url))

        let model = NodeAppModel()
        delegate.appModel = model
        let link = await Self.waitForGatewaySetup(in: model)

        #expect(link?.host == "gateway.example.com")
        #expect(link?.token == "tok")
    }

    @Test @MainActor func `rejects an invalid URL`() throws {
        let delegate = OpenClawAppDelegate()
        let url = try #require(URL(string: "https://example.com/gateway"))

        #expect(!delegate.application(UIApplication.shared, open: url))
    }

    @Test func `live voice intent exposes its description through the AppIntent protocol`() {
        let intent: any AppIntent.Type = StartLiveVoiceIntent.self
        #expect(intent.description != nil)
    }

    @Test @MainActor func `live voice intent survives cold launch and waits for an active scene`() async throws {
        try await withUserDefaults(["talk.enabled": false]) {
            let previousModel = OpenClawAppModelRegistry.appModel
            OpenClawAppModelRegistry.appModel = nil
            defer { OpenClawAppModelRegistry.appModel = previousModel }

            _ = try await StartLiveVoiceIntent().perform()
            _ = try await StartLiveVoiceIntent().perform()
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            defer { model.setTalkEnabled(false) }
            OpenClawAppModelRegistry.appModel = model
            model.focusChatSession("agent:main:shortcut-test")

            model.consumeLiveVoiceStartRequest(
                isSceneActive: false, isOnboardingPresented: false, hasGatewayConfiguration: true)
            #expect(model.pendingLiveVoiceStart)
            #expect(!model.talkMode.isEnabled)
            #expect(model.openChatRequestID == 0)

            model.consumeLiveVoiceStartRequest(
                isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)
            #expect(!model.pendingLiveVoiceStart)
            #expect(model.talkMode.isEnabled)
            #expect(model.chatSessionKey == "agent:main:shortcut-test")
            #expect(model.talkMode.isUsingMainSessionKey("agent:main:shortcut-test"))
            let requestID = model.openChatRequestID
            #expect(model.consumeOpenChatRequest(requestID))
            #expect(!model.consumeOpenChatRequest(requestID))

            model.consumeLiveVoiceStartRequest(
                isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)
            #expect(model.openChatRequestID == requestID)
            let replacement = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            defer { replacement.setTalkEnabled(false) }
            OpenClawAppModelRegistry.appModel = replacement
            #expect(!replacement.pendingLiveVoiceStart)
        }
    }

    @Test @MainActor
    func `warm live voice intent opens the selected chat without toggling existing voice`() async throws {
        try await withUserDefaults(["talk.enabled": false]) {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            let previousModel = OpenClawAppModelRegistry.appModel
            OpenClawAppModelRegistry.appModel = model
            defer {
                model.setTalkEnabled(false)
                OpenClawAppModelRegistry.appModel = previousModel
            }
            model.focusChatSession("agent:main:voice-session")
            model.setTalkEnabled(true)
            model.talkMode.statusText = "Existing conversation"

            for _ in 0..<2 {
                _ = try await StartLiveVoiceIntent().perform()
                model.consumeLiveVoiceStartRequest(
                    isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)
                #expect(model.talkMode.isEnabled)
                #expect(model.talkMode.statusText == "Existing conversation")
                #expect(model.chatSessionKey == "agent:main:voice-session")
                #expect(model.consumeOpenChatRequest(model.openChatRequestID))
                #expect(model.liveVoiceStartError == nil)
            }
        }
    }

    @Test(arguments: [true, false]) @MainActor
    func `live voice request is rejected rather than replayed after setup`(isOnboardingPresented: Bool) {
        withUserDefaults(["talk.enabled": false]) {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            defer { model.setTalkEnabled(false) }
            model.requestLiveVoiceStart()
            model.consumeLiveVoiceStartRequest(
                isSceneActive: true,
                isOnboardingPresented: isOnboardingPresented,
                hasGatewayConfiguration: isOnboardingPresented)

            #expect(!model.pendingLiveVoiceStart)
            #expect(!model.talkMode.isEnabled)
            #expect(model.liveVoiceStartError?.contains("Connect to your Gateway") == true)
            model.consumeLiveVoiceStartRequest(
                isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)
            #expect(!model.talkMode.isEnabled)
            #expect(model.openChatRequestID == 0)
        }
    }

    @Test @MainActor func `live voice surfaces the canonical capture rejection`() {
        withUserDefaults(["talk.enabled": false, "talk.background.enabled": false]) {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            defer { model.setTalkEnabled(false) }
            model.enterAppleReviewDemoMode()
            model.requestLiveVoiceStart()
            model.consumeLiveVoiceStartRequest(
                isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)

            #expect(!model.pendingLiveVoiceStart)
            #expect(!model.talkMode.isEnabled)
            #expect(model.liveVoiceStartError == "Demo mode only")
            #expect(model.consumeOpenChatRequest(model.openChatRequestID))
        }
    }

    @Test(arguments: [
        (["operator.read", "operator.write", "operator.talk.secrets"], true, true),
        (["operator.admin"], true, true),
        (["operator.read", "operator.talk"], true, true),
        (["operator.read", "operator.talk.secrets"], true, false),
        (["operator.read", "operator.write", "operator.talk.secrets"], false, true),
    ]) @MainActor
    func `native live voice prepares the bound owner using admitted method scopes`(
        scopes: [String],
        globalPermissionReady: Bool,
        shouldPrepare: Bool) async throws
    {
        try await withUserDefaults(["talk.enabled": false, "talk.background.enabled": false]) {
            let session = OpenClawNativeSessionRef(
                owner: OpenClawNativeOwnerRef(gatewayID: "native-voice-gateway", profileID: "profile-a"),
                agentID: "main",
                sessionKey: "agent:main:native-voice")
            var configRequests: [Bool] = []
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                hello: .init(
                    role: "operator",
                    scopes: scopes,
                    capabilities: [GatewayServerCapability.profileBinding.rawValue]),
                rpcHandler: { frame in
                    Self.nativeVoiceRPCResponse(
                        for: frame,
                        session: session,
                        scopes: scopes,
                        configRequests: &configRequests)
                })
            defer { fixture.stop() }
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            let gateway = model.operatorSession
            let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
            let router = NativeActionRouter(appModel: model, gatewayController: controller)
            var chat: OpenClawChatViewModel?
            var presentationID: UUID?
            var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
            options.allowStoredDeviceAuth = false
            options.deviceAuthGatewayID = session.owner.gatewayID
            let url = fixture.url()
            do {
                defer {
                    model.setOperatorConnected(false)
                    model.setTalkEnabled(false)
                    model.talkMode.updateGatewayConnected(false)
                    if let presentationID { router.unregisterPresentation(presentationID) }
                    chat?.detachTransport()
                    model.activeGatewayConnectConfig = nil
                }
                try await gateway.connect(
                    url: url,
                    credentials: .init(),
                    connectOptions: options,
                    sessionBox: nil,
                    onConnected: {},
                    onDisconnected: { _ in },
                    onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                model.activeGatewayConnectConfig = GatewayConnectConfig(
                    url: url,
                    stableID: session.owner.gatewayID,
                    tls: nil,
                    token: nil,
                    bootstrapToken: nil,
                    password: nil,
                    nodeOptions: options)
                model.setOperatorConnected(true)
                model.talkMode.updateGatewayConnected(true)
                model.focusChatSession(session.sessionKey)
                var presented: [OpenClawNativeOpenRequest] = []
                presentationID = router.registerPresentation { request, binding in
                    presented.append(request)
                    #expect(binding.session == session)
                    #expect(binding.gateway === gateway)
                    model.focusChatSession(request.session.sessionKey)
                    let transport = try #require(
                        model.makeChatTransport(nativeBinding: binding) as? IOSGatewayChatTransport)
                    let viewModel = OpenClawChatViewModel(
                        sessionKey: session.sessionKey,
                        transport: transport,
                        activeAgentId: session.agentID,
                        sessionRoutingContract: binding.sessionRoutingContract,
                        transcriptCache: nil,
                        outbox: nil)
                    chat = viewModel
                    router.registerChat(
                        viewModel,
                        ownerID: model.chatViewModelOwnerID,
                        agentID: session.agentID,
                        transport: transport,
                        presentationID: presentationID)
                    viewModel.load()
                }
                model.talkMode
                    .gatewayTalkPermissionState = globalPermissionReady ? .ready :
                    .missingScope("operator.talk.secrets")

                let outcome = await router.open(.liveVoice(session))

                #expect(presented == [.liveVoice(session)])
                let chat = try #require(chat)
                #expect(chat.healthOK)
                #expect(!chat.isLoading)
                #expect(chat.errorText == nil)
                #expect(model.chatSessionKey == session.sessionKey)
                #expect(!model.talkMode.isEnabled)
                #expect(!model.talkMode.isListening)
                #expect(!UserDefaults.standard.bool(forKey: "talk.enabled"))
                if shouldPrepare {
                    let canReadSecrets = scopes.contains("operator.admin") || scopes.contains("operator.talk.secrets")
                    #expect(configRequests == (canReadSecrets ? [true] : [true, false]))
                    if case let .unavailable(reason) = outcome {
                        #expect(!reason.isEmpty)
                    } else {
                        Issue.record("Closed microphone admission must not acknowledge native voice as opened")
                    }
                } else {
                    #expect(configRequests.isEmpty)
                    #expect(outcome == .unavailable(
                        reason: "Open voice in the selected chat and finish its permission setup first."))
                }
            } catch {
                await gateway.disconnect()
                throw error
            }
            await gateway.disconnect()
        }
    }

    @MainActor
    private static func nativeVoiceRPCResponse(
        for frame: [String: Any],
        session: OpenClawNativeSessionRef,
        scopes: [String],
        configRequests: inout [Bool]) -> NativeGatewayWebSocketFixture.RPCResponse
    {
        guard let method = frame["method"] as? String else {
            Issue.record("Native voice fixture request is missing its method")
            return .failure(code: "INVALID_REQUEST", message: "Missing method")
        }
        #expect(frame["expectedProfileId"] as? String == session.owner.profileID)
        let params = frame["params"] as? [String: Any] ?? [:]
        switch method {
        case "users.self":
            return .success(["profile": ["id": session.owner.profileID]])
        case "agents.list":
            return .success([
                "defaultId": "main",
                "mainKey": "main",
                "scope": "per-sender",
                "agents": [["id": "main"]],
            ])
        case "chat.history":
            #expect(params["sessionKey"] as? String == session.sessionKey)
            #expect(params["agentId"] as? String == session.agentID)
            return .success([
                "sessionKey": session.sessionKey, "messages": [],
                "sessionInfo": ["key": session.sessionKey, "agentId": session.agentID],
            ])
        case "sessions.list":
            return .success(["ts": 0, "count": 0, "sessions": []])
        case "models.list":
            return .success(["models": []])
        case "health":
            return .success(["ok": true])
        case "sessions.messages.subscribe":
            return .success(["subscribed": true, "key": session.sessionKey])
        case "chat.metadata":
            return .success(["swarmEnabled": false])
        case "tasks.list":
            return .success(["tasks": []])
        case "talk.config":
            let includeSecrets = params["includeSecrets"] as? Bool == true
            configRequests.append(includeSecrets)
            if includeSecrets,
               !scopes.contains("operator.admin"), !scopes.contains("operator.talk.secrets")
            {
                return .failure(
                    code: "FORBIDDEN",
                    message: "missing scope: operator.talk.secrets",
                    details: [
                        "code": "MISSING_SCOPE",
                        "missingScope": "operator.talk.secrets",
                        "requiredScopes": ["operator.read", "operator.talk.secrets"],
                    ])
            }
            return .success(["config": ["talk": ["resolved": [
                "provider": "google", "config": [String: Any](),
            ]]]])
        default:
            Issue.record("Unexpected native voice fixture request: \(method)")
            return .failure(code: "INVALID_REQUEST", message: "Unexpected fixture method: \(method)")
        }
    }

    @MainActor
    private static func waitForGatewaySetup(in model: NodeAppModel) async -> GatewayConnectDeepLink? {
        for _ in 0..<20 {
            if model.gatewaySetupRequestID > 0 {
                return model.consumePendingGatewaySetupLink()
            }
            await Task.yield()
        }
        return nil
    }
}
