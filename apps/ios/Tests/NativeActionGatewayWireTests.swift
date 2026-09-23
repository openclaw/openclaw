import CryptoKit
import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

/// The harness requires every case's completion, so an absent or mis-selected suite cannot pass CI.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_ACTION_FIXTURE"] != nil))
struct NativeActionGatewayWireTests {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let sessionKey: String
            let marker: String
            let message: String
        }

        struct Media: Decodable {
            struct Session: Decodable {
                let sessionKey: String
                let artifactID: String
            }

            let pngBase64: String
            let sha256: String
            let sessions: [String: Session]
        }

        let version: Int
        let gatewayURL: URL
        let controlURL: URL
        let controlToken: String
        let gatewayID: String
        let aliceProfileID: String
        let bobProfileID: String
        let cases: [String: Case]
        let media: Media

        func control(_ action: String, fields: [String: String] = [:]) async throws -> ControlResponse {
            var request = URLRequest(url: self.controlURL)
            request.httpMethod = "POST"
            request.timeoutInterval = 210
            request.setValue(self.controlToken, forHTTPHeaderField: "x-qa-fixture-token")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(fields.merging(["action": action]) { _, next in next })
            let (data, response) = try await URLSession.shared.data(for: request)
            try #require((response as? HTTPURLResponse)?.statusCode == 200)
            return try JSONDecoder().decode(ControlResponse.self, from: data)
        }

        func verify(_ id: String, runID: String? = nil, complete: Bool = true) async throws {
            var fields = ["case": id, "outcome": runID == nil ? "rejected" : "allowed"]
            fields["runId"] = runID
            _ = try await self.control("verify", fields: fields)
            if complete {
                _ = try await self.control("complete", fields: ["case": id])
            }
        }
    }

    private struct ControlResponse: Decodable {
        struct HeldResponse: Decodable {
            let method: String
            let ok: Bool
            let runId: String?
            let sha256: String?
            let sizeBytes: Int?
        }

        let heldResponse: HeldResponse?
        let canvasOrigin: URL?
        let signInGatewayURL: URL?
        let signInAuthChoice: String?
    }

    @MainActor
    private final class Presentation {
        let fixture: Fixture
        let model: NodeAppModel
        let controller: GatewayConnectionController
        let router: NativeActionRouter
        let gatewayURL: URL
        let scopes: [String]
        let pairAction: String
        var presentationID: UUID?
        var chatRegistrationID: UUID?
        var binding: IOSNativeActionBinding?
        var chat: OpenClawChatViewModel? {
            self.model.chatPresentation.viewModel
        }

        var transport: IOSGatewayChatTransport? {
            self.model.chatPresentation.transport
        }

        init(fixture: Fixture, signInGatewayURL: URL? = nil) {
            self.fixture = fixture
            self.gatewayURL = signInGatewayURL ?? fixture.gatewayURL
            self.scopes = ["operator.read", "operator.write"] + (signInGatewayURL == nil ? [] : ["operator.admin"])
            self.pairAction = signInGatewayURL == nil ? "pair" : "pair-signin"
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            self.model = model
            let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
            self.controller = controller
            self.router = NativeActionRouter(appModel: model, gatewayController: controller)
            self.presentationID = self.router.registerPresentation(onRetire: { [weak self] _ in
                self?.binding = nil
            }, onSessionAdopted: { [weak self] previous, binding in
                guard let self, self.binding == nil || self.binding?.canReuse(previous) == true else { return }
                self.binding = binding
            }) { [weak self] request, binding, _ in
                guard let self else { throw CancellationError() }
                self.model.setSelectedAgentId(request.session.agentID)
                self.model.focusChatSession(request.session.sessionKey)
                let owner = self.model.chatPresentation
                owner.sync(
                    appModel: self.model, nativeBinding: binding,
                    nativeActions: self.router, presentationID: self.presentationID)
                self.binding = binding
                let chat = try #require(owner.viewModel)
                let transport = try #require(owner.transport)
                try #require(transport.nativeBinding?.canReuse(binding) == true)
                self.chatRegistrationID = self.router.registerChat(
                    chat, ownerID: owner.ownerID, agentID: owner.transportAgentID,
                    transport: transport, presentationID: self.presentationID)
            }
        }

        func connect() async throws {
            let options = GatewayConnectOptions(
                role: "operator",
                scopes: self.scopes,
                scopesAreExplicit: true,
                caps: [OpenClawGatewayClientCapability.agentKind, OpenClawGatewayClientCapability.inlineWidgets],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "ui",
                clientDisplayName: "Native wire proof",
                includeDeviceIdentity: true,
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: self.fixture.gatewayID)
            let connect = {
                try await self.model.operatorSession.connect(
                    url: self.gatewayURL,
                    credentials: .init(),
                    connectOptions: options,
                    sessionBox: nil,
                    onConnected: {},
                    onDisconnected: { _ in },
                    onInvoke: { BridgeInvokeResponse(id: $0.id, ok: false) })
            }
            do {
                try await connect()
            } catch {
                // The first signed native connection must enter real device pairing.
                // The fixture fails if this was any other connect failure.
                _ = try await self.fixture.control(self.pairAction)
                try await connect()
            }
            self.model.activeGatewayConnectConfig = GatewayConnectConfig(
                url: self.gatewayURL,
                stableID: self.fixture.gatewayID,
                tls: nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: options)
            self.model.connectedGatewayID = self.fixture.gatewayID
            self.model.setOperatorConnected(true)
            let route = try #require(await self.model.operatorSession.currentRoute(ifGatewayID: self.fixture.gatewayID))
            let scopes = await self.model.operatorSession.currentOperatorScopes(ifCurrentRoute: route)
            try #require(scopes == Set(self.scopes))
        }

        func prepare(_ id: String, profileID: String? = nil) async throws -> OpenClawNativePreparedSend {
            let spec = try #require(self.fixture.cases[id])
            let session = OpenClawNativeSessionRef(
                owner: .init(
                    gatewayID: self.fixture.gatewayID,
                    profileID: profileID ?? self.fixture.aliceProfileID),
                agentID: "qa",
                sessionKey: spec.sessionKey)
            do {
                return try await self.router.prepareSend(to: session, message: spec.message).send
            } catch {
                // Read public state before cleanup, without suspending or exposing identities.
                // Missing owners leave their readiness and identity checks unknown.
                let state: [(String, Bool?)] = [
                    ("presentationPresent", self.presentationID != nil),
                    ("chatPresent", self.chat != nil),
                    ("transportPresent", self.transport != nil),
                    ("bindingPresent", self.binding != nil),
                    ("operatorConnected", self.model.isOperatorGatewayConnected),
                    ("loading", self.chat?.isLoading),
                    ("healthOK", self.chat?.healthOK),
                    ("errorPresent", self.chat.map { $0.errorText != nil }),
                    ("modelSessionMatches", self.model.chatSessionKey.utf8.elementsEqual(session.sessionKey.utf8)),
                    ("chatSessionMatches", self.chat?.sessionKey.utf8.elementsEqual(session.sessionKey.utf8)),
                    ("agentMatches", self.model.chatDeliveryAgentId?.utf8.elementsEqual(session.agentID.utf8)),
                    (
                        "gatewayMatches",
                        self.model.chatTranscriptCacheGatewayID?.utf8
                            .elementsEqual(session.owner.gatewayID.utf8)),
                    ("bindingSessionMatches", self.binding.map { $0.session == session }),
                    ("transportBindingMatches", self.binding.flatMap { self.transport?.nativeBinding?.canReuse($0) }),
                ]
                let fields = state.map { name, value in
                    "\(name)=\(value.map { String($0) } ?? "unknown")"
                }
                let role = self.pairAction == "pair" ? "writer" : "sign-in"
                print("native prepare failed: role=\(role); case=\(id); \(fields.joined(separator: "; "))")
                throw error
            }
        }

        func requireSettled(_ run: OpenClawNativeRunRef, before nextID: String? = nil) async throws {
            let chat = try #require(self.chat)
            let target = chat.currentSessionTarget
            let binding = try #require(self.binding)
            try #require(binding.session == run.session)
            try #require(target.sessionKey == run.session.sessionKey)
            try #require(
                (OpenClawChatSessionKey.agentID(from: target.sessionKey) ?? target.agentID) == run.session.agentID)
            // Server verification does not settle the client's live-run owner.
            // Observe its actual readiness before asking it to adopt another target.
            try await AsyncTimeout.withTimeout(seconds: 2, onTimeout: { URLError(.timedOut) }) { @MainActor in
                while !(chat.pendingRunCount == 0 && !chat.isLoading && !chat.isSending &&
                    chat.canPreserveIdleTextDraft)
                {
                    try await Task.sleep(for: .milliseconds(1))
                }
            }
            let current = await binding.isCurrent()
            try #require(current)
            try #require(self.chat === chat && chat.currentSessionTarget == target)
            try #require(self.binding?.canReuse(binding) == true)
            try #require(self.transport?.nativeBinding?.canReuse(binding) == true)
            try #require(chat.pendingRunCount == 0 && !chat.isLoading && !chat.isSending)
            try #require(chat.canPreserveIdleTextDraft && chat.healthOK && chat.errorText == nil)
            let owner = self.model.chatPresentation
            try #require(!owner.hasProtectedComposer(appModel: self.model))
            if let nextID {
                let spec = try #require(self.fixture.cases[nextID])
                let next = OpenClawNativeSessionRef(
                    owner: run.session.owner, agentID: run.session.agentID, sessionKey: spec.sessionKey)
                try #require(owner.canPresentNativeSession(next, appModel: self.model))
            }
        }

        func disconnect() async {
            self.chat?.detachTransport()
            self.router.unregisterChat(self.chatRegistrationID)
            self.chatRegistrationID = nil
            self.binding = nil
            self.model.setOperatorConnected(false)
            await self.model.operatorSession.disconnect()
        }

        func close() async {
            if let presentationID {
                self.router.unregisterPresentation(presentationID)
            }
            await self.disconnect()
            self.model.activeGatewayConnectConfig = nil
            self.model.voiceWake.stop()
            self.model.setTalkEnabled(false)
            await self.model.purgeChatTranscriptCache(gatewayID: self.fixture.gatewayID)
        }
    }

    @Test @MainActor
    func `prepared native actions use real gateway authority and receipts`() async throws {
        let raw = try #require(ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_ACTION_FIXTURE"])
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(raw.utf8))
        try #require(fixture.version == 1)
        try #require(fixture.gatewayURL.scheme == "ws" && fixture.gatewayURL.host == "127.0.0.1")
        try #require(fixture.controlURL.scheme == "http" && fixture.controlURL.host == "127.0.0.1")
        try #require(!fixture.controlToken.isEmpty && fixture.aliceProfileID != fixture.bobProfileID)
        var presentation = Presentation(fixture: fixture)
        let signInConfig = try await fixture.control("signin-config")
        let signInURL = try #require(signInConfig.signInGatewayURL)
        try #require(signInURL.scheme == "ws" && signInURL.host == "127.0.0.1")
        let authChoice = try #require(signInConfig.signInAuthChoice)
        let signIn = Presentation(fixture: fixture, signInGatewayURL: signInURL)
        do {
            try await presentation.connect()
            let retired = try await presentation.prepare("allowed")
            let oldChat = try #require(presentation.chat)
            let originalKey = retired.session.sessionKey
            let originalBinding = try #require(presentation.binding)
            let originalTransport = try #require(presentation.transport)
            for key in ["agent:qa:native-navigation-away", originalKey] {
                try #require(oldChat.switchSession(to: key))
                let binding = try #require(presentation.binding)
                let transport = try #require(presentation.transport)
                let session = OpenClawNativeSessionRef(
                    owner: retired.session.owner, agentID: retired.session.agentID, sessionKey: key)
                try #require(presentation.chat === oldChat)
                try #require(oldChat.currentSessionTarget == OpenClawChatSessionTarget(
                    sessionKey: key,
                    agentID: OpenClawChatSessionKey.agentID(from: key) == nil ? session.agentID : nil))
                try #require(presentation.model.chatSessionKey == key)
                try #require(presentation.model.chatDeliveryAgentId == session.agentID)
                try #require(binding.session == session)
                try #require(transport.nativeBinding?.session == session)
                try #require(transport.nativeBinding?.canReuse(binding) == true)
                try #require(transport.gateway === originalTransport.gateway)
                try #require(binding.route == originalBinding.route)
                try #require(binding.profileObservationID == originalBinding.profileObservationID)
            }
            try #require(originalTransport.nativeBinding?.session == retired.session)
            let currentRoute = await originalBinding.gateway.currentRoute(
                ifGatewayID: retired.session.owner.gatewayID)
            try #require(currentRoute == originalBinding.route)
            await #expect(throws: Error.self) { _ = try await retired.submit() }
            // The unchanged fixture's final one-admission/provider/sentinel count
            // proves this retired confirmation added no work before the fresh send.
            let prepared = try await presentation.prepare("allowed")
            let accepted = try await prepared.submit()
            try await fixture.verify("allowed", runID: accepted.runID, complete: false)
            let replay = try await prepared.submit()
            try #require(replay == accepted)
            try await fixture.verify("allowed", runID: replay.runID)
            try await presentation.requireSettled(accepted, before: "distinct")

            let distinct = try await presentation.prepare("distinct").submit()
            try #require(distinct.runID != accepted.runID)
            try await fixture.verify("distinct", runID: distinct.runID)
            try await presentation.requireSettled(distinct, before: "aclSuspended")
            await #expect(throws: Error.self) {
                _ = try await presentation.prepare("foreign", profileID: fixture.bobProfileID)
            }
            try await fixture.verify("foreign")

            _ = try await Self.rejectAcrossSuspension(
                presentation, first: "aclSuspended", second: "acl", mutation: "revoke-acl")
            let aclControl = try await presentation.prepare("controlACL").submit()
            try await fixture.verify("controlACL", runID: aclControl.runID)
            try await presentation.requireSettled(aclControl, before: "accepted")
            try await Self.verifyMedia(presentation, id: "controlACL", session: "controlACL", allowed: true)
            try await Self.retireMediaResult(presentation)

            try await Self.retireAcceptedSubmission(presentation)
            // The held ACK intentionally retired a live owner. Its replay is now
            // proven; later cases get a new UI lifetime, not cleared pending facts.
            await presentation.close()
            presentation = Presentation(fixture: fixture)
            try await presentation.connect()
            let widget = try await Self.verifyWidgetRetirement(presentation)
            try await signIn.connect()
            _ = try await signIn.prepare("controlACL")
            let aliceSignIn = try await Self.beginSignIn(signIn, authChoice: authChoice)
            _ = try await fixture.control("signin-checkpoint", fields: ["checkpoint": "admitted"])
            let profileCapture = try await Self.rejectAcrossSuspension(
                presentation, first: "profileSuspended", second: "profile", mutation: "merge-profile")
            try await Self.verifySignInRetirement(signIn, admitted: aliceSignIn)
            _ = try await Self.verifyWidget(
                presentation,
                id: "profile",
                transport: widget.transport,
                replacing: widget.resource,
                allowed: false,
                alsoRejecting: profileCapture.transport)
            let profileControl = try await presentation.prepare(
                "controlProfile", profileID: fixture.bobProfileID).submit()
            try await fixture.verify("controlProfile", runID: profileControl.runID)
            try await presentation.requireSettled(profileControl)
            let freshBinding = try #require(presentation.binding)
            try await Self.requireProfileRejection(profileCapture.prepared)
            try #require(await freshBinding.isCurrent())
            try await Self.verifyMedia(presentation, id: "controlProfile", session: "controlProfile", allowed: true)
            _ = try await Self.verifyWidget(
                presentation,
                id: "controlProfile",
                transport: #require(presentation.transport),
                allowed: true)
        } catch {
            await signIn.close()
            await presentation.close()
            throw error
        }
        await signIn.close()
        await presentation.close()
    }

    private struct SignInReply: Decodable {
        struct Step: Decodable {
            let id: String
            let type: String
            let message: String?
        }

        let sessionId: String?
        let done: Bool?
        let status: String?
        let step: Step?
    }

    private struct SignInOptions: Decodable {
        struct Capability: Decodable {
            struct Option: Decodable { let id: String }
            let loginOptions: [Option]?
        }

        let providerCapabilities: [Capability]?
    }

    private struct SignInAttempt {
        let context: OpenClawChatModelSignInContext
        let binding: IOSNativeActionBinding
        let sessionID: String
        let authChoice: String

        func loginParams(sessionID: String) -> [String: OpenClawProtocol.AnyCodable] {
            [
                "sessionId": .init(sessionID),
                "agentId": .init(self.context.agentID),
                "authChoice": .init(self.authChoice),
            ]
        }
    }

    @MainActor
    private static func beginSignIn(_ presentation: Presentation, authChoice: String) async throws -> SignInAttempt {
        let transport = try #require(presentation.transport)
        let context = try #require(await transport.acquireModelSignInContext(agentID: "qa"))
        let binding = try #require(presentation.binding)
        let attempt = SignInAttempt(
            context: context,
            binding: binding,
            sessionID: UUID().uuidString,
            authChoice: authChoice)
        let status = try await context.request("models.authStatus", ["agentId": .init(context.agentID)])
        let options = try JSONDecoder().decode(SignInOptions.self, from: status)
        let available = (options.providerCapabilities ?? []).flatMap { $0.loginOptions ?? [] }
        try #require(available.contains { $0.id == authChoice })
        let data = try await context.request("models.authLogin", attempt.loginParams(sessionID: attempt.sessionID))
        let started = try JSONDecoder().decode(SignInReply.self, from: data)
        try #require(started.sessionId == attempt.sessionID)
        try #require(started.status == "running")
        // Gateway login skips the CLI scope notice. Keep the provider's input unanswered
        // so profile and route retirement must cancel and settle the same admitted flow.
        let promptData = try await context.request("wizard.next", ["sessionId": .init(attempt.sessionID)])
        let prompt = try JSONDecoder().decode(SignInReply.self, from: promptData)
        try #require(prompt.done == false)
        try #require(prompt.status == "running")
        let step = try #require(prompt.step)
        try #require(step.type == "text")
        try #require(step.message == "Native sign-in cancellation proof")
        return attempt
    }

    @MainActor
    private static func requireWizardAbsent(_ attempt: SignInAttempt, sessionID: String) async throws {
        do {
            // Untagged on the original physical owner: another client or a retired
            // profile tag could hide a still-live wizard instead of proving cleanup.
            _ = try await attempt.binding.gateway.request(
                method: "wizard.status",
                params: ["sessionId": .init(sessionID)],
                ifCurrentRoute: attempt.binding.route)
            throw OpenClawNativeActionError("The native sign-in wizard survived cleanup.")
        } catch let error as GatewayResponseError {
            try #require(error.details["code"]?.stringValue == "WIZARD_NOT_FOUND")
        }
    }

    @MainActor
    private static func closeSignIn(_ attempt: SignInAttempt) async throws {
        let data = try await attempt.context.closeWizard(attempt.sessionID)
        let terminal = try JSONDecoder().decode(SignInReply.self, from: data)
        try #require(terminal.status == "error")
        try await self.requireWizardAbsent(attempt, sessionID: attempt.sessionID)
    }

    @MainActor
    private static func verifySignInRetirement(_ presentation: Presentation, admitted: SignInAttempt) async throws {
        let fixture = presentation.fixture
        try await self.closeSignIn(admitted)
        _ = try await fixture.control("signin-checkpoint", fields: ["checkpoint": "cleaned"])
        let deniedID = UUID().uuidString
        do {
            _ = try await admitted.context.request("models.authLogin", admitted.loginParams(sessionID: deniedID))
            throw OpenClawNativeActionError("Retired native sign-in authority started a wizard.")
        } catch let error as GatewayResponseError {
            try #require(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
            try #require(error.details["execution"]?.stringValue == "not_started")
        }
        try await self.requireWizardAbsent(admitted, sessionID: deniedID)
        _ = try await fixture.control("signin-checkpoint", fields: ["checkpoint": "denied"])

        _ = try await presentation.prepare("controlACL", profileID: fixture.bobProfileID)
        let bob = try await self.beginSignIn(presentation, authChoice: admitted.authChoice)
        try await self.closeSignIn(bob)
        _ = try await fixture.control("signin-checkpoint", fields: ["checkpoint": "profile"])

        await presentation.disconnect()
        try await presentation.connect()
        _ = try await presentation.prepare("controlACL", profileID: fixture.bobProfileID)
        let successor = try await self.beginSignIn(presentation, authChoice: admitted.authChoice)
        _ = try await fixture.control("signin-checkpoint", fields: ["checkpoint": "replacement"])
        do {
            _ = try await bob.context.request("models.authLogin", bob.loginParams(sessionID: UUID().uuidString))
            throw OpenClawNativeActionError("A replaced sign-in route started a wizard.")
        } catch GatewayNodeSessionRequestError.routeChangedBeforeDispatch {}
        do {
            _ = try await bob.context.closeWizard(successor.sessionID)
            throw OpenClawNativeActionError("A replaced sign-in route closed the successor wizard.")
        } catch is CancellationError {}
        _ = try await fixture.control("signin-checkpoint", fields: ["checkpoint": "retired"])
        let data = try await successor.context.request("wizard.status", ["sessionId": .init(successor.sessionID)])
        let status = try JSONDecoder().decode(SignInReply.self, from: data)
        try #require(status.status == "running")
        try await self.closeSignIn(successor)
        _ = try await fixture.control("signin-checkpoint", fields: ["checkpoint": "complete"])
    }

    @MainActor
    private static func verifyWidget(
        _ presentation: Presentation,
        id: String,
        transport: IOSGatewayChatTransport,
        replacing failed: OpenClawChatWidgetResource? = nil,
        allowed: Bool,
        recover: Bool = false,
        alsoRejecting retained: IOSGatewayChatTransport? = nil) async throws -> OpenClawChatWidgetResource?
    {
        let fixture = presentation.fixture
        let started = try await fixture.control("widget-start", fields: ["case": id])
        let origin = try #require(started.canvasOrigin)
        let resource = await transport.resolveInlineWidgetResource(
            path: "/__openclaw__/canvas/documents/native.html", replacing: failed)
        if allowed {
            let resolved = try #require(resource, "The allowed native widget did not resolve.")
            try self.requireWidgetAuthority(resolved, origin: origin)
            if recover {
                let replacement = try #require(await transport.resolveInlineWidgetResource(
                    path: "/__openclaw__/canvas/documents/native.html", replacing: resolved))
                try self.requireWidgetAuthority(replacement, origin: origin)
                let rotated = replacement.url != resolved.url
                try #require(rotated, "Widget recovery reused the failed capability.")
            }
        } else {
            let rejected = resource == nil
            try #require(rejected, "Retired native widget authority returned a resource.")
            if let retained {
                let binding = try #require(retained.nativeBinding)
                try #require(await binding.isCurrent() == false)
                try #require(await retained.resolveInlineWidgetResource(
                    path: "/__openclaw__/canvas/documents/native.html", replacing: nil) == nil)
            }
        }
        var fields = ["case": id, "outcome": allowed ? "allowed" : "rejected"]
        if id == "profile" {
            let binding = try #require(transport.nativeBinding)
            try #require(await binding.isCurrent() == false)
            try #require(await binding.gateway.currentRoute() == binding.route)
            fields["locallyRetired"] = "true"
        }
        _ = try await fixture.control(
            "widget-complete", fields: fields)
        return resource
    }

    private static func requireWidgetAuthority(_ resource: OpenClawChatWidgetResource, origin: URL) throws {
        // Compare the independent hello advertisement, not the WebSocket proxy port.
        try #require(resource.url.scheme == origin.scheme)
        try #require(resource.url.host == origin.host)
        try #require(resource.url.port == origin.port)
        let matchesDocument = resource.url.path.hasPrefix("/__openclaw__/cap/") &&
            resource.url.path.hasSuffix("/__openclaw__/canvas/documents/native.html")
        try #require(matchesDocument)
    }

    @MainActor
    private static func verifyWidgetRetirement(
        _ presentation: Presentation) async throws
        -> (transport: IOSGatewayChatTransport, resource: OpenClawChatWidgetResource)
    {
        let fixture = presentation.fixture
        _ = try await presentation.prepare("controlACL")
        let transport = try #require(presentation.transport)
        _ = try await self.verifyWidget(
            presentation, id: "allowed", transport: transport, allowed: true, recover: true)
        let failed = try #require(await transport.resolveInlineWidgetResource(
            path: "/__openclaw__/canvas/documents/native.html", replacing: nil))
        _ = try await fixture.control("widget-start", fields: ["case": "retiredResult"])
        _ = try await fixture.control("hold-response", fields: ["method": "plugin.surface.refresh"])
        let loading = Task { @MainActor in
            await transport.resolveInlineWidgetResource(
                path: "/__openclaw__/canvas/documents/native.html", replacing: failed)
        }
        var holding = false
        do {
            let held = try #require(try await fixture.control("wait-held").heldResponse)
            holding = true
            try #require(held.method == "plugin.surface.refresh" && held.ok)
            await presentation.disconnect()
            try await presentation.connect()
            _ = try await fixture.control("release-response")
            holding = false
            let rejected = await loading.value == nil
            try #require(rejected, "A retired widget refresh returned a resource.")
            _ = try await fixture.control(
                "widget-complete", fields: ["case": "retiredResult", "outcome": "rejected"])
        } catch {
            if holding { _ = try? await fixture.control("release-response") }
            loading.cancel()
            _ = await loading.value
            throw error
        }
        _ = try await self.verifyWidget(
            presentation, id: "retiredLookup", transport: transport, allowed: false)
        _ = try await presentation.prepare("controlACL")
        let fresh = try #require(presentation.transport)
        let resource = try #require(try await self.verifyWidget(
            presentation, id: "retiredControl", transport: fresh, allowed: true))
        return (fresh, resource)
    }

    @MainActor
    private static func requireRejection(_ result: Result<OpenClawNativeRunRef, Error>) throws {
        guard case let .failure(error) = result else {
            throw OpenClawNativeActionError("A retired native action was unexpectedly accepted")
        }
        try #require(!error.localizedDescription.isEmpty)
    }

    @MainActor
    private static func requireProfileRejection(_ prepared: OpenClawNativePreparedSend) async throws {
        do {
            _ = try await prepared.submit()
            throw OpenClawNativeActionError("The retired account unexpectedly accepted a confirmation.")
        } catch let error as GatewayResponseError {
            try #require(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
            try #require(error.details["execution"]?.stringValue == "not_started")
        }
    }

    @MainActor
    private static func rejectAcrossSuspension(
        _ presentation: Presentation,
        first: String,
        second: String,
        mutation: String) async throws
        -> (transport: IOSGatewayChatTransport, prepared: OpenClawNativePreparedSend)
    {
        let fixture = presentation.fixture
        if second == "profile" {
            presentation.chat?.detachTransport()
            presentation.router.unregisterChat(presentation.chatRegistrationID)
        }
        let suspended = try await presentation.prepare(first)
        let firstBinding = try #require(presentation.binding)
        let beforeAdmission = try await presentation.prepare(second)
        let retainedTransport = try #require(presentation.transport)
        let secondBinding = try #require(retainedTransport.nativeBinding)
        try await Self.verifyMedia(
            presentation, id: "\(second)Allowed", session: second, allowed: true, transport: retainedTransport)
        if second == "profile" {
            try #require(firstBinding.session != secondBinding.session)
            try #require(!firstBinding.canReuse(secondBinding))
            try #require(await retainedTransport.resolveInlineWidgetResource(
                path: "/__openclaw__/canvas/documents/native.html", replacing: nil) != nil)
            // Close the real presentation subscribers. A later account broadcast
            // must not stand in for propagation of the retained confirmation's refusal.
            presentation.chat?.detachTransport()
            presentation.router.unregisterChat(presentation.chatRegistrationID)
            try await AsyncTimeout.withTimeout(seconds: 2, onTimeout: { URLError(.timedOut) }) {
                while await secondBinding.gateway._test_serverEventSubscriberCount() != 0 {
                    try await Task.sleep(for: .milliseconds(1))
                }
            }
            try #require(await firstBinding.isCurrent())
            try #require(await secondBinding.isCurrent())
        }
        _ = try await fixture.control("hold-response", fields: ["method": "users.self"])
        let submission = Task { @MainActor in try await suspended.submit() }
        do {
            let held = try #require(try await fixture.control("wait-held").heldResponse)
            try #require(held.method == "users.self" && held.ok)
            _ = try await fixture.control(mutation)
            _ = try await fixture.control("release-response")
            if second == "profile" {
                do {
                    _ = try await submission.value
                    throw OpenClawNativeActionError("The closed presentation accepted a confirmation.")
                } catch let error as OpenClawNativeActionError {
                    try #require(error
                        .localizedDescription == "The selected session changed. Open it again before sending.")
                }
                // Neither a broadcast nor B's own request has retired this warm
                // capture. Only A's next typed refusal may invalidate both owners.
                try #require(await firstBinding.isCurrent())
                try #require(await secondBinding.isCurrent())
                try await Self.requireProfileRejection(suspended)
                try #require(await firstBinding.isCurrent() == false)
                try #require(await secondBinding.isCurrent() == false)
                try #require(await secondBinding.gateway.currentRoute() == secondBinding.route)
            } else {
                try await Self.requireRejection(submission.result)
            }
            try await fixture.verify(first)
            let direct = Task { @MainActor in try await beforeAdmission.submit() }
            try await Self.requireRejection(direct.result)
            try await fixture.verify(second)
            try await Self.verifyMedia(
                presentation, id: second, session: second, allowed: false, transport: retainedTransport)
            return (retainedTransport, suspended)
        } catch {
            await presentation.disconnect()
            submission.cancel()
            _ = await submission.result
            throw error
        }
    }

    @MainActor
    private static func verifyMedia(
        _ presentation: Presentation,
        id: String,
        session: String,
        allowed: Bool,
        transport retained: IOSGatewayChatTransport? = nil) async throws
    {
        let fixture = presentation.fixture
        let media = try #require(fixture.media.sessions[session])
        let transport = try #require(retained ?? presentation.transport)
        _ = try await fixture.control("media-start", fields: ["case": id])
        var fields = ["case": id, "outcome": allowed ? "allowed" : "rejected"]
        if allowed {
            let loaded = try await transport.loadMediaArtifact(
                sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
            guard case let .data(image) = loaded else {
                throw OpenClawNativeActionError("The native media loader did not return image bytes.")
            }
            let expected = try #require(Data(base64Encoded: fixture.media.pngBase64))
            try #require(image.mimeType == "image/png" && image.data == expected)
            let digest = SHA256.hash(data: image.data).map { String(format: "%02x", $0) }.joined()
            try #require(digest == fixture.media.sha256)
            fields["sha256"] = digest
        } else if id == "profile" {
            // The earlier typed profile rejection retires this exact capture.
            // Its later lookup must stop locally, before artifact authorization.
            let binding = try #require(transport.nativeBinding)
            try #require(await binding.isCurrent() == false)
            try #require(await transport.gateway.currentRoute() == binding.route)
            let loaded = try await transport.loadMediaArtifact(
                sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
            try #require(loaded == nil)
            fields["locallyRetired"] = "true"
        } else {
            let rejection: Error?
            do {
                _ = try await transport.loadMediaArtifact(
                    sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
                rejection = nil
            } catch {
                rejection = error
            }
            let error = try #require(rejection, "Retired native media authority was accepted.")
            try #require(!error.localizedDescription.isEmpty)
        }
        _ = try await fixture.control("media-complete", fields: fields)
    }

    @MainActor
    private static func retireMediaResult(_ presentation: Presentation) async throws {
        let fixture = presentation.fixture
        let media = try #require(fixture.media.sessions["controlACL"])
        let transport = try #require(presentation.transport)
        _ = try await fixture.control("media-start", fields: ["case": "retiredResult"])
        _ = try await fixture.control("hold-response", fields: ["method": "media.get"])
        let loading = Task { @MainActor in
            try await transport.loadMediaArtifact(
                sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
        }
        var holding = false
        do {
            let held = try #require(try await fixture.control("wait-held").heldResponse)
            holding = true
            let expected = try #require(Data(base64Encoded: fixture.media.pngBase64))
            try #require(held.method == "media.get" && held.ok)
            try #require(held.sha256 == fixture.media.sha256 && held.sizeBytes == expected.count)
            await presentation.disconnect()
            _ = try await fixture.control("release-response")
            holding = false
            switch await loading.result {
            case .success:
                throw OpenClawNativeActionError("A retired media request published its held result.")
            case let .failure(error):
                try #require(error is CancellationError)
            }
            _ = try await fixture.control(
                "media-complete", fields: ["case": "retiredResult", "outcome": "rejected"])
            try await presentation.connect()
            _ = try await presentation.prepare("controlACL")
            try await Self.verifyMedia(presentation, id: "retiredControl", session: "controlACL", allowed: true)
        } catch {
            if holding { _ = try? await fixture.control("release-response") }
            loading.cancel()
            _ = await loading.result
            throw error
        }
    }

    @MainActor
    private static func retireAcceptedSubmission(_ presentation: Presentation) async throws {
        let fixture = presentation.fixture
        let prepared = try await presentation.prepare("accepted")
        let binding = try #require(presentation.binding)
        let transport = try #require(presentation.transport)
        try #require(transport.nativeBinding?.canReuse(binding) == true)
        _ = try await fixture.control("hold-response", fields: ["method": "chat.send"])
        var holding = true
        let submission = Task { @MainActor in try await prepared.submit() }
        do {
            let held = try #require(try await fixture.control("wait-held").heldResponse)
            try #require(held.method == "chat.send" && held.ok)
            let runID = try #require(held.runId)
            await presentation.disconnect()
            let disconnectedRoute = await binding.gateway.currentRoute(ifGatewayID: fixture.gatewayID)
            try #require(disconnectedRoute == nil)
            _ = try await fixture.control("release-response")
            holding = false
            switch await submission.result {
            case let .success(receipt):
                try #require(receipt.runID == runID)
            case let .failure(error):
                // A real successful ACK already exists; retirement is not proof of non-execution.
                try #require(error.localizedDescription.localizedCaseInsensitiveContains("unconfirmed"))
            }
            try await fixture.verify("accepted", runID: runID, complete: false)
            try await presentation.connect()
            let successorRoute = try #require(await binding.gateway.currentRoute(ifGatewayID: fixture.gatewayID))
            try #require(successorRoute != binding.route)
            try #require(transport.nativeBinding?.route == binding.route)
            try #require(transport.nativeBinding?.session == binding.session)
            try #require(await binding.isCurrent() == false)
            let replay = Task { @MainActor in try await prepared.submit() }
            try await Self.requireRejection(replay.result)
            try await fixture.verify("accepted", runID: runID)
        } catch {
            if holding { _ = try? await fixture.control("release-response") }
            await presentation.disconnect()
            submission.cancel()
            _ = await submission.result
            throw error
        }
    }
}
