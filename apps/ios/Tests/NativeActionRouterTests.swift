import Foundation
import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI
@testable import OpenClawKit

private enum NativeRouteReadContext {
    @TaskLocal static var held = false
}

private final class NativeRouteReadGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var released = false
    private var waiting = false
    private var expired = false

    var entered: Bool {
        self.condition.lock()
        defer { self.condition.unlock() }
        return self.waiting
    }

    var timedOut: Bool {
        self.condition.lock()
        defer { self.condition.unlock() }
        return self.expired
    }

    func wait() {
        self.condition.lock()
        defer { self.condition.unlock() }
        self.waiting = true
        let deadline = Date().addingTimeInterval(5)
        while !self.released {
            if !self.condition.wait(until: deadline) { self.expired = true
                return
            }
        }
    }

    func release() {
        self.condition.lock()
        self.released = true
        self.condition.broadcast()
        self.condition.unlock()
    }
}

private final class NativeRouteReadSession: WebSocketSessioning, @unchecked Sendable {
    private final class Socket: WebSocketTasking {
        let task: URLSessionWebSocketTask
        let gate: NativeRouteReadGate
        init(task: URLSessionWebSocketTask, gate: NativeRouteReadGate) {
            self.task = task
            self.gate = gate
        }

        var state: URLSessionTask.State {
            if NativeRouteReadContext.held { self.gate.wait() }
            return self.task.state
        }

        func resume() {
            self.task.resume()
        }

        func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            self.task.cancel(with: closeCode, reason: reason)
        }

        func send(_ message: URLSessionWebSocketTask.Message) async throws {
            try await self.task.send(message)
        }

        func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
            self.task.sendPing(pongReceiveHandler: pongReceiveHandler)
        }

        func receive() async throws -> URLSessionWebSocketTask.Message {
            try await self.task.receive()
        }

        func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
            self.task.receive(completionHandler: completionHandler)
        }
    }

    let session = URLSession(configuration: .ephemeral)
    let gate = NativeRouteReadGate()
    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        WebSocketTaskBox(task: Socket(task: self.session.webSocketTask(with: request), gate: self.gate))
    }
}

@MainActor
struct NativeActionRouterTests {
    @Test func `modal actions freeze root registration and dismiss only their receipt`() throws {
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
        let router = NativeActionRouter(appModel: model, gatewayController: controller)
        let chat = OpenClawChatViewModel(
            sessionKey: "agent:main:modal", transport: LocalFixtureChatTransport(fixture: .appleReviewDemo))
        let owner = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: chat)
        owner.synchronize(origin: origin)
        defer { owner.invalidate(origin: origin)
            chat.detachTransport()
        }
        var oldRetirements = 0
        let oldRoot = router.registerPresentation(onRetire: { _ in oldRetirements += 1 }, { _, _, _ in })
        let actions = RootTabs.makeChatModalActions(
            origin: origin, router: router, rootID: oldRoot,
            isCurrentScope: { true }, isCurrentContainer: { true })
        let oldAuthority = try #require(router.capturePresentationAuthority(oldRoot))
        let first = try #require(owner.present(
            "Original",
            at: \.widgetError,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                actions: actions)))
        #expect(!router.isCurrentPresentation(oldAuthority))
        #expect(oldRetirements == 1)
        let pending = try #require(owner.capture(origin: origin, producerID: UUID(), actions: actions))
        var successorRetirements = 0
        let successor = router.registerPresentation(
            onRetire: { _ in successorRetirements += 1 }, { _, _, _ in })
        defer { router.unregisterPresentation(successor) }
        let current = try #require(router.capturePresentationAuthority(successor))
        #expect(actions.capture(origin) == nil)
        #expect(owner.present("Stale", at: \.widgetError, capture: pending) == nil)
        #expect(router.isCurrentPresentation(current))
        owner.dismiss(first.receipt)
        #expect(!owner.hasActivePresentation)
        #expect(successorRetirements == 0)
        #expect(router.isCurrentPresentation(current))

        let fresh = RootTabs.makeChatModalActions(
            origin: origin, router: router, rootID: successor,
            isCurrentScope: { true }, isCurrentContainer: { true })
        let replacement = try #require(owner.present(
            "Original",
            at: \.widgetError,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                actions: fresh)))
        let afterOpen = try #require(router.capturePresentationAuthority(successor))
        owner.dismiss(first.receipt)
        #expect(owner.widgetError?.id == replacement.id)
        #expect(router.isCurrentPresentation(afterOpen))
        router.unregisterPresentation(successor)
        owner.dismiss(replacement.receipt)
        #expect(!owner.hasActivePresentation)
    }

    @Test func `modal container permit cannot replace newer same target inspection`() async throws {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let chat = try #require(host.chat)
            let owner = OpenClawChatModalPresentations()
            let origin = OpenClawChatModalOrigin(viewModel: chat)
            owner.synchronize(origin: origin)
            defer { owner.invalidate(origin: origin) }
            let rootID = try #require(host.presentationID)
            let containingReceipt = host.receipt?.id
            let actions = RootTabs.makeChatModalActions(
                origin: origin, router: host.router, rootID: rootID,
                isCurrentScope: { host.chat === chat },
                isCurrentContainer: { host.receipt?.id == containingReceipt })
            let delayed = try #require(owner.capture(origin: origin, producerID: UUID(), actions: actions))
            let publicationRelease = AsyncStream<Void>.makeStream()
            var publicationAttempted = false
            let publication = Task { @MainActor in
                for await _ in publicationRelease.stream {
                    break
                }
                #expect(owner.present("Late widget error", at: \.widgetError, capture: delayed) == nil)
                publicationAttempted = true
            }
            let inspection = Task { try await host.router.inspect(
                .init(session: host.session(), runID: "run-a")).inspection }
            do {
                let receipt = try await host.waitForReceipt()
                let authority = try #require(host.router.capturePresentationAuthority(rootID))
                #expect(host.chat === chat)
                #expect(delayed.receipt.isCurrentScope())
                publicationRelease.continuation.finish()
                await publication.value
                #expect(publicationAttempted)
                #expect(host.receipt?.id == receipt.id)
                #expect(host.router.isCurrentPresentation(authority))
                #expect(!owner.hasActivePresentation)
                host.router.acknowledgeInspection(receipt, presentationID: rootID)
                _ = try await inspection.value
                #expect(host.sent.isEmpty)
            } catch {
                publicationRelease.continuation.finish()
                await publication.value
                inspection.cancel()
                _ = try? await inspection.value
                throw error
            }
        }
    }

    @Test func `accepted app modal keeps nested publication and exact dismissal authority`() throws {
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
        let router = NativeActionRouter(appModel: model, gatewayController: controller)
        let chat = OpenClawChatViewModel(
            sessionKey: "agent:main:modal", transport: LocalFixtureChatTransport(fixture: .appleReviewDemo))
        let owner = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: chat)
        owner.synchronize(origin: origin)
        var container: RootTabs.PresentedSheet?
        let rootID = router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
        defer {
            owner.invalidate(origin: origin)
            router.unregisterPresentation(rootID)
            chat.detachTransport()
        }
        let capturedAbsence = container
        let actions = RootTabs.makeChatModalActions(
            origin: origin, router: router, rootID: rootID,
            isCurrentScope: { true }, isCurrentContainer: { container == capturedAbsence })
        let appCapture = try #require(owner.capture(origin: origin, producerID: UUID(), actions: actions))
        #expect(appCapture.accept())
        container = .newSessionOptions(chat, receipt: appCapture.receipt)
        let parent = container
        #expect(appCapture.receipt.isCurrentScope())
        let nestedActions = RootTabs.makeChatModalActions(
            origin: origin, router: router, rootID: rootID,
            isCurrentScope: { true }, isCurrentContainer: { container == parent })
        let child = try #require(owner.present(
            "Nested reader error",
            at: \.widgetError,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                ancestors: [appCapture.receipt.id],
                parentIsCurrent: { container == parent },
                actions: nestedActions)))
        owner.dismiss(child.receipt)
        #expect(container == parent)
        #expect(appCapture.receipt.retireIfCurrent())
        owner.removeDescendants(of: appCapture.receipt)
        container = nil
        #expect(!owner.hasActivePresentation)
    }

    @Test(arguments: ["receipt", "root"])
    func `Pages callbacks and dismissal require their exact receipt and Root`(retirement: String) throws {
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
        let router = NativeActionRouter(appModel: model, gatewayController: controller)
        let root = router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
        var currentRoot = root
        defer { router.unregisterPresentation(currentRoot) }
        var presentation: RootTabs.SidebarPagesPresentation?
        let storage = Binding(get: { presentation }, set: { presentation = $0 })
        let admit: @MainActor @Sendable () -> Bool = { router.userNavigationDidChange(presentationID: root) }
        let isCurrentRoot: @MainActor @Sendable () -> Bool = { router.capturePresentationAuthority(root) != nil }
        let beforeOpening = try #require(router.capturePresentationAuthority(root))
        let receipt = RootTabs.SidebarPagesPresentation()
        RootTabs.matchedModalBinding(storage, admit: admit).wrappedValue = receipt
        #expect(presentation == receipt)
        #expect(!router.isCurrentPresentation(beforeOpening))
        var pins = 0
        var selections = 0
        let dismiss = RootTabs.matchedModalBinding(storage, admit: admit)
        let pin = {
            RootSidebar.performPagesEditorAction(receipt, presentation: storage, isCurrentRoot: isCurrentRoot) {
                pins += 1
            }
        }
        let select = {
            RootSidebar.performPagesEditorAction(receipt, presentation: storage, isCurrentRoot: isCurrentRoot) {
                dismiss.wrappedValue = nil
                selections += 1
            }
        }
        pin()
        #expect(pins == 1)
        let expected: RootTabs.SidebarPagesPresentation
        if retirement == "receipt" {
            expected = RootTabs.SidebarPagesPresentation()
            RootTabs.matchedModalBinding(storage, admit: admit).wrappedValue = expected
        } else {
            expected = receipt
            router.unregisterPresentation(root)
            currentRoot = router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
        }
        let successor = try #require(router.capturePresentationAuthority(currentRoot))
        pin()
        select()
        dismiss.wrappedValue = nil
        #expect(pins == 1)
        #expect(selections == 0)
        #expect(presentation == expected)
        #expect(router.isCurrentPresentation(successor))
        let liveRoot = currentRoot
        RootTabs.matchedModalBinding(storage, admit: {
            router.userNavigationDidChange(presentationID: liveRoot)
        }).wrappedValue = nil
        #expect(presentation == nil)
        #expect(!router.isCurrentPresentation(successor))
        #expect(!router.isCurrentPresentation(beforeOpening))
    }

    @Test func `exact presentation anchor teardown cannot unregister successor`() {
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
        let router = NativeActionRouter(appModel: model, gatewayController: controller)
        let lifetime = IOSNativePresentationLifetime()
        let first = router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
        lifetime.own(first) { router.unregisterPresentation(first) }
        let second = router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
        let current = router.capturePresentationAuthority(second)
        lifetime.release()
        lifetime.release()
        #expect(current.map { router.isCurrentPresentation($0) } == true)
        router.unregisterPresentation(second)
    }

    @Test func `user navigation admits only its captured root and never revives an old selection`() {
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
        let router = NativeActionRouter(appModel: model, gatewayController: controller)
        let root = router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
        let original = router.capturePresentationAuthority(root)
        #expect(!router.userNavigationDidChange(presentationID: UUID()))
        #expect(original.map { router.isCurrentPresentation($0) } == true)
        #expect(router.userNavigationDidChange(presentationID: root))
        #expect(original.map { router.isCurrentPresentation($0) } == false)
        let successor = router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
        let current = router.capturePresentationAuthority(successor)
        #expect(!router.userNavigationDidChange(presentationID: root))
        #expect(current.map { router.isCurrentPresentation($0) } == true)
        router.unregisterPresentation(successor)
    }

    @Test func `local fixture fork keeps its deliberate unsupported outcome`() async {
        var adopted = false
        let prepared = PreparedChatNavigation(
            parent: .init(sessionKey: "global", agentID: "main"),
            transport: LocalFixtureChatTransport(fixture: .appleReviewDemo),
            gatewayID: nil, isLocalFixture: true, isCurrent: { true },
            open: { _ in adopted = true
                return true
            })
        do {
            _ = try await prepared.fork(fromLastCompleted: false)
            Issue.record("Local fixtures do not implement fork")
        } catch OpenClawChatTransportSendError.notDispatched {
        } catch {
            Issue.record("Unexpected local fixture outcome: \(error)")
        }
        #expect(!adopted)
    }

    @MainActor
    private final class Host {
        let model: NodeAppModel
        let controller: GatewayConnectionController
        let router: NativeActionRouter
        let gatewayID = "native-target-\(UUID().uuidString)"
        var fixture: NativeGatewayWebSocketFixture?
        var presentationID: UUID?
        var chatRegistrationID: UUID?
        var binding: IOSNativeActionBinding?
        var receipt: NativeActionRouter.RunPresentation?
        var chat: OpenClawChatViewModel? {
            self.model.chatPresentation.viewModel
        }

        var sent: [[String: Any]] = []
        var createdSessions = 0
        var presentations = 0
        var ordinaryChat = false
        var retired = 0
        var rejectPresentation = false
        var registerPresentedChat = true
        var beforeInspectionHistory: (() -> Void)?
        var beforeResponse: ((String) -> Void)?
        var beforeSendReply: (() -> Void)?
        var deferredSendReply: (@MainActor @Sendable () async -> Void)?
        var deferredForkReply: (@MainActor @Sendable () async -> Void)?
        var deferredNewChatReply: (@MainActor @Sendable () async -> Void)?
        var newChatFrames: [[String: Any]] = []
        var historyKeys: [String] = []
        var retainsSessionTransitionBinding = false
        var profileID = "alice"
        var catalogDiscovery = false
        var boundedSessionRows: [[String: Any]]?
        var boundedSessionListRequests: [[String: Any]] = []
        var rejectMethod: String?
        var rejectionExecution = "not_started"
        var requestsBeforeRejection = 0
        var widgetRefreshes = 0
        var rosterRequests = 0
        var nativeReads: [String] = []
        var issuedRunIDs: Set<String> = []
        var callbackViolations: [String] = []
        var callbackViolationCount = 0

        func observeCallback(_ condition: Bool, rule: String, method: String) {
            guard !condition else { return }
            self.callbackViolationCount += 1
            if self.callbackViolations.count < 16 {
                self.callbackViolations.append("method=\(method) rule=\(rule)")
            }
        }

        init() {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            self.model = model
            let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
            self.controller = controller
            self.router = NativeActionRouter(appModel: model, gatewayController: controller)
            self.registerPresentation()
        }

        func registerPresentation() {
            self.presentationID = self.router.registerPresentation(onRetire: { [weak self] disposition in
                self?.retired += 1
                if case .chatSessionTransition = disposition, self?.retainsSessionTransitionBinding == true {
                    // This fixture can exercise Root's in-place transition contract.
                } else {
                    self?.binding = nil
                }
                self?.receipt = nil
            }, onSessionAdopted: { [weak self] previous, binding in
                guard let self, self.binding == nil || self.binding?.canReuse(previous) == true else { return }
                self.binding = binding
            }) { [weak self] request, binding, receipt in
                guard let self, !self.rejectPresentation else { throw CancellationError() }
                self.presentations += 1
                self.model.setSelectedAgentId(request.session.agentID)
                self.model.focusChatSession(request.session.sessionKey)
                self.receipt = receipt
                let owner = self.model.chatPresentation
                owner.sync(
                    appModel: self.model, nativeBinding: binding,
                    nativeActions: self.router, presentationID: self.presentationID)
                self.binding = binding
                if self.registerPresentedChat, let chat = owner.viewModel, let transport = owner.transport,
                   transport.nativeBinding?.canReuse(binding) == true
                {
                    self.chatRegistrationID = self.router.registerChat(
                        chat, ownerID: owner.ownerID, agentID: owner.transportAgentID,
                        transport: transport, presentationID: self.presentationID)
                }
            }
        }

        func session(_ agent: String = "main") -> OpenClawNativeSessionRef {
            .init(owner: .init(gatewayID: self.gatewayID, profileID: "alice"), agentID: agent, sessionKey: "global")
        }

        func startFixture(acceptsStartup: Bool = false) async throws -> NativeGatewayWebSocketFixture {
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                hello: .init(role: "operator", scopes: ["operator.read", "operator.write"], capabilities: [
                    GatewayServerCapability.profileBinding.rawValue,
                    GatewayServerCapability.chatSendRoutingContract.rawValue,
                    GatewayServerCapability.sessionSettingsCAS.rawValue,
                ]),
                rpcHandler: { [weak self] request in
                    guard let self else { return .failure(code: "UNAVAILABLE", message: "Fixture closed") }
                    let params = request["params"] as? [String: Any] ?? [:]
                    let methodLabel: String = switch request["method"] as? String {
                    case let method? where [
                        "users.self",
                        "plugin.surface.refresh",
                        "agents.list",
                        "chat.history",
                        "sessions.messages.subscribe",
                        "sessions.create",
                        "health",
                        "sessions.list",
                        "chat.send",
                        "agent.wait",
                        "models.list",
                        "commands.list",
                        "chat.metadata",
                        "tasks.list",
                        "config.get", "users.prefs.get", "talk.config", "voicewake.get",
                        "exec.approval.list", "plugin.approval.list", "openclaw.approval.list",
                        "node.event", "node.pending.pull",
                    ]
                        .contains(method): method
                    default: "unknown"
                    }
                    if methodLabel == "sessions.create", self.deferredForkReply != nil {
                        self.observeCallback(
                            request["expectedProfileId"] == nil && Set(params.keys) == [
                                "parentSessionKey",
                                "agentId",
                                "fork",
                            ] &&
                                params["parentSessionKey"] as? String == "global" &&
                                params["agentId"] as? String == "main" && params["fork"] as? Bool == true,
                            rule: "prepared-fork-route", method: methodLabel)
                    } else if request["method"] as? String == "sessions.list", params["limit"] as? Int == 80 {
                        // Agent selection also refreshes the ordinary UI share route.
                        self.observeCallback(
                            request["expectedProfileId"] == nil,
                            rule: "share-profile",
                            method: methodLabel)
                        self.observeCallback(
                            Set(params.keys) == ["limit", "includeGlobal", "includeUnknown", "agentId"],
                            rule: "share-shape",
                            method: methodLabel)
                        self.observeCallback(
                            params["includeGlobal"] as? Bool == true,
                            rule: "share-global",
                            method: methodLabel)
                        self.observeCallback(
                            params["includeUnknown"] as? Bool == false,
                            rule: "share-unknown",
                            method: methodLabel)
                        self.observeCallback(
                            ["main", "research"].contains(params["agentId"] as? String ?? ""),
                            rule: "share-agent",
                            method: methodLabel)
                    } else if acceptsStartup, request["expectedProfileId"] == nil {
                        // The saved-Gateway path starts both real loops. Only these
                        // hydration calls are unprofiled; native reads still require alice.
                        let valid: Bool = switch methodLabel {
                        case "config.get", "agents.list", "health", "voicewake.get", "node.pending.pull",
                             "exec.approval.list", "plugin.approval.list", "openclaw.approval.list":
                            params.isEmpty
                        case "users.prefs.get":
                            Set(params.keys) == ["keys"] && params["keys"] as? [String] == ["ui.accent"]
                        case "talk.config":
                            params.isEmpty || (Set(params.keys) == ["includeSecrets"] &&
                                params["includeSecrets"] as? Bool == true)
                        case "node.event":
                            Set(params.keys) == ["event", "payloadJSON"] &&
                                params["event"] as? String == "node.host.stats" && params["payloadJSON"] is String
                        case "chat.history":
                            Set(params.keys).isSubset(of: ["sessionKey", "agentId"]) &&
                                params["sessionKey"] is String
                        default: false
                        }
                        self.observeCallback(valid, rule: "startup-read-shape", method: methodLabel)
                    } else if self.ordinaryChat {
                        // Only ordinary-owner tests bootstrap without a captured profile.
                        // Native fixtures retain the exact profile assertion below.
                        self.observeCallback([
                            "agents.list", "chat.history", "sessions.messages.subscribe", "health",
                            "sessions.list", "models.list", "commands.list", "chat.metadata", "tasks.list",
                        ].contains(methodLabel), rule: "ordinary-read-method", method: methodLabel)
                        self.observeCallback(
                            request["expectedProfileId"] == nil, rule: "ordinary-profile", method: methodLabel)
                    } else {
                        let isCatalog = self.catalogDiscovery && (
                            request["method"] as? String == "users.self" ||
                                (request["method"] as? String == "sessions.list" && params["limit"] as? Int == 50))
                        let expected = isCatalog ? (request["method"] as? String == "users.self" ? nil : self.profileID)
                            : "alice"
                        self.observeCallback(
                            request["expectedProfileId"] as? String == expected,
                            rule: "selected-profile",
                            method: methodLabel)
                    }
                    if request["method"] as? String == "chat.send" { self.sent.append(params) }
                    if request["expectedProfileId"] != nil, ["users.self", "chat.history"].contains(methodLabel) {
                        self.nativeReads.append(methodLabel)
                    }
                    if request["method"] as? String == "sessions.create" { self.createdSessions += 1 }
                    if request["method"] as? String == self.rejectMethod {
                        if self.requestsBeforeRejection == 0 {
                            self.rejectMethod = nil
                            return .failure(code: "INVALID_REQUEST", message: "Selected profile changed", details: [
                                "reason": "EXPECTED_PROFILE_MISMATCH", "execution": self.rejectionExecution,
                            ])
                        }
                        self.requestsBeforeRejection -= 1
                    }
                    self.beforeResponse?(request["method"] as? String ?? "")
                    switch request["method"] as? String {
                    case "config.get": return .success([
                            "config": ["session": ["mainKey": "main", "scope": "per-sender"]],
                        ])
                    case "users.prefs.get": return .success(["status": "ok", "entries": [:]])
                    case "node.pending.pull": return .success(["actions": []])
                    case "node.event": return .success([:])
                    case "talk.config", "voicewake.get", "exec.approval.list", "plugin.approval.list",
                         "openclaw.approval.list":
                        return .failure(code: "UNAVAILABLE", message: "Optional fixture capability unavailable")
                    case "users.self": return .success(["profile": ["id": self.profileID]])
                    case "plugin.surface.refresh":
                        self.widgetRefreshes += 1
                        return .success(["pluginSurfaceUrls": [
                            "canvas": "http://native-widget.invalid/__openclaw__/cap/fixture",
                        ]])
                    case "agents.list":
                        self.rosterRequests += 1
                        return .success([
                            "defaultId": "main", "mainKey": "main", "scope": "per-sender",
                            "agents": [["id": "main"], ["id": "research"]],
                        ])
                    case "chat.history":
                        self.historyKeys.append(params["sessionKey"] as? String ?? "")
                        if params["inputRunIds"] != nil {
                            let before = self.beforeInspectionHistory
                            self.beforeInspectionHistory = nil
                            before?()
                        }
                        let key = params["sessionKey"] as? String ?? ""
                        let agent = params["agentId"] as? String ?? OpenClawChatSessionKey.agentID(from: key) ?? "main"
                        return .success([
                            "sessionKey": key, "sessionId": "session-\(agent)", "messages": [],
                            "sessionInfo": [
                                "key": key, "agentId": agent, "sessionId": "session-\(agent)",
                                "permissionMode": "guarded", "toolOverrides": [:],
                                "activeRunIds": params["inputRunIds"] as? [String] ?? [],
                            ],
                        ])
                    case "sessions.messages.subscribe":
                        return .success(["subscribed": true, "key": params["key"] as? String ?? ""])
                    case "health": return .success(["ok": true])
                    case "sessions.list":
                        if let boundedSessionRows = self.boundedSessionRows {
                            self.boundedSessionListRequests.append(params)
                            let search = params["search"] as? String
                            let agent = params["agentId"] as? String
                            let matches = boundedSessionRows.filter { row in
                                (agent == nil || row["agentId"] as? String == agent) &&
                                    (search == nil || (row["displayName"] as? String)?
                                        .localizedCaseInsensitiveContains(search ?? "") == true)
                            }
                            let rows = Array(matches.prefix(params["limit"] as? Int ?? matches.count))
                            return .success(["ts": 0, "count": rows.count, "sessions": rows])
                        }
                        return .success([
                            "ts": 0, "count": 2, "sessions": ["main", "research"].map {
                                ["key": "global", "agentId": $0, "permissionMode": "guarded", "toolOverrides": [:]]
                            },
                        ])
                    case "sessions.create":
                        if let deferred = self.deferredNewChatReply {
                            self.deferredNewChatReply = nil
                            self.newChatFrames.append(request)
                            let key = params["key"] as? String ?? ""
                            self.observeCallback(
                                !key.isEmpty && Set(params.keys) == ["key", "agentId", "parentSessionKey"] &&
                                    params["parentSessionKey"] as? String == "global" &&
                                    params["agentId"] as? String == "main",
                                rule: "new-chat-route", method: methodLabel)
                            return .deferred {
                                await deferred()
                                return .success(["key": key])
                            }
                        }
                        guard let deferred = self.deferredForkReply else {
                            self.observeCallback(false, rule: "unowned-fork", method: methodLabel)
                            return .failure(code: "INVALID_REQUEST", message: "Unowned fixture fork")
                        }
                        self.deferredForkReply = nil
                        return .deferred {
                            await deferred()
                            return .success(["key": "agent:main:forked"])
                        }
                    case "chat.send":
                        let before = self.beforeSendReply
                        self.beforeSendReply = nil
                        before?()
                        let runID = "run-\(self.sent.count)"
                        self.issuedRunIDs.insert(runID)
                        if let deferred = self.deferredSendReply {
                            self.deferredSendReply = nil
                            return .deferred {
                                await deferred()
                                return .success(["runId": runID, "status": "ok"])
                            }
                        }
                        return .success(["runId": runID, "status": "ok"])
                    case "agent.wait":
                        // An accepted send can arm its waiter before terminal-ACK reconciliation.
                        // Only IDs actually issued by this fixture have a completed run to inspect.
                        let valid = Set(params.keys) == ["runId", "timeoutMs"] &&
                            self.issuedRunIDs.contains(params["runId"] as? String ?? "") &&
                            (params["timeoutMs"] as? Int ?? 0) > 0
                        self.observeCallback(valid, rule: "issued-run-wait", method: methodLabel)
                        guard valid else { return .failure(code: "INVALID_REQUEST", message: "Invalid fixture wait") }
                        return .success(["status": "ok"])
                    case "models.list", "commands.list": return .success([
                            request["method"] as? String == "models.list" ? "models" : "commands": [],
                        ])
                    case "chat.metadata": return .success(["swarmEnabled": false])
                    case "tasks.list": return .success(["tasks": []])
                    default:
                        self.observeCallback(false, rule: "unexpected-method", method: methodLabel)
                        return .failure(code: "INVALID_REQUEST", message: "Unexpected fixture method")
                    }
                })
            self.fixture = fixture
            return fixture
        }

        func connect(sessionBox: WebSocketSessionBox? = nil) async throws {
            let fixture = try await self.startFixture()
            var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
            options.allowStoredDeviceAuth = false
            options.deviceAuthGatewayID = self.gatewayID
            try await self.model.operatorSession.connect(
                url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: sessionBox,
                onConnected: {}, onDisconnected: { _ in }, onInvoke: { .init(id: $0.id, ok: true) })
            self.model.activeGatewayConnectConfig = GatewayConnectConfig(
                url: fixture.url(), stableID: self.gatewayID, tls: nil, token: nil,
                bootstrapToken: nil, password: nil, nodeOptions: options)
            self.model.connectedGatewayID = self.gatewayID
            self.model.setOperatorConnected(true)
        }

        func prepare(_ agent: String = "main") async throws -> OpenClawNativePreparedSend {
            try await self.router.prepareSend(to: self.session(agent), message: "one intentional message").send
        }

        func openOrdinaryChat() async throws -> OpenClawChatViewModel {
            self.ordinaryChat = true
            self.model.setSelectedAgentId("main")
            self.model.focusChatSession("global")
            let owner = self.model.chatPresentation
            owner.sync(appModel: self.model)
            let chat = try #require(owner.viewModel)
            let transport = try #require(owner.transport)
            self.chatRegistrationID = self.router.registerChat(
                chat, ownerID: owner.ownerID, agentID: owner.transportAgentID,
                transport: transport, presentationID: self.presentationID)
            let deadline = ContinuousClock.now + .seconds(2)
            while chat.isLoading, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(!chat.isLoading)
            #expect(chat.healthOK)
            #expect(chat.errorText == nil)
            return chat
        }

        func hideChat() throws {
            try self.router.unregisterChat(#require(self.chatRegistrationID))
            self.chatRegistrationID = nil
        }

        func waitForReceipt(after previous: UUID? = nil) async throws -> NativeActionRouter.RunPresentation {
            let deadline = ContinuousClock.now + .seconds(2)
            while self.receipt == nil || self.receipt?.id == previous, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            let receipt = try #require(self.receipt)
            try #require(receipt.id != previous)
            return receipt
        }

        func acknowledgingInspection<T: Sendable>(
            _ operation: @escaping @MainActor () async throws -> T) async throws -> T
        {
            let previous = self.receipt?.id
            let task = Task { try await operation() }
            do {
                let receipt = try await self.waitForReceipt(after: previous)
                self.router.acknowledgeInspection(receipt, presentationID: self.presentationID)
                return try await task.value
            } catch {
                task.cancel()
                _ = try? await task.value
                throw error
            }
        }

        func close() async {
            self.beforeInspectionHistory = nil
            self.beforeResponse = nil
            self.beforeSendReply = nil
            self.deferredSendReply = nil
            self.deferredForkReply = nil
            self.deferredNewChatReply = nil
            if let presentationID { self.router.unregisterPresentation(presentationID) }
            self.chat?.detachTransport()
            await self.model.operatorSession.disconnect()
            await self.fixture?.stopAndWait()
            self.model.activeGatewayConnectConfig = nil
            self.model.voiceWake.stop()
            await self.model.purgeChatTranscriptCache(gatewayID: self.gatewayID)
        }
    }

    private func withHost(
        sessionBox: WebSocketSessionBox? = nil, foreground: Bool = false,
        _ run: (Host) async throws -> Void) async throws
    {
        try await withUserDefaults([
            "talk.enabled": false, "talk.background.enabled": false, VoiceWakePreferences.enabledKey: false,
        ]) {
            let host = Host()
            if foreground { host.model.setScenePhase(.active) }
            let outcome: Result<Void, Error>
            do {
                try await host.connect(sessionBox: sessionBox)
                try await run(host)
                outcome = .success(())
            } catch {
                outcome = .failure(error)
            }
            await host.close()
            // NW callbacks do not carry Swift Testing's originating task context.
            // Close admission and join their writers before reporting any violations here.
            #expect(
                host.callbackViolationCount == 0,
                "count=\(host.callbackViolationCount) overflow=\(host.callbackViolationCount > 16) \(host.callbackViolations.joined(separator: " | "))")
            try outcome.get()
        }
    }

    @Test(arguments: ["current", "account-aba", "config-aba"])
    func `in-place New Chat retains native transport and rejects retired adoption`(retirement: String) async throws {
        try await self.withHost { host in
            host.retainsSessionTransitionBinding = true
            let prepared = try await host.prepare()
            let owner = host.model.chatPresentation
            let chat = try #require(owner.viewModel)
            if let bootstrap = chat.bootstrapTask { await bootstrap.value }
            try #require(chat.canPreserveIdleTextDraft && chat.input.isEmpty && !chat.isLoading)
            let parent = try #require(host.binding)
            let transport = try #require(owner.transport)
            let target = chat.currentSessionTarget
            let oldAuthority = chat.captureSessionTransitionAuthority()
            try #require(oldAuthority())
            let current: @MainActor () -> IOSChatViewModelOwner.Presentation = {
                .init(binding: host.binding, router: host.router, id: host.presentationID)
            }
            try #require(host.router.userNavigationDidChange(
                presentationID: host.presentationID, disposition: .chatSessionTransition))
            #expect(!oldAuthority())
            owner.requestNewChat(appModel: host.model, presentation: current())
            await owner.synchronizePresentation(appModel: host.model, currentPresentation: current)
            let request = try #require(owner.currentNewChatRequest(appModel: host.model, presentation: current()))
            #expect(request.origin.binding === parent)
            #expect(request.binding === parent)
            let entered = AsyncStream<Void>.makeStream()
            let release = AsyncStream<Void>.makeStream()
            host.deferredNewChatReply = {
                entered.continuation.yield(())
                for await _ in release.stream {
                    break
                }
            }
            let creating = Task { @MainActor in
                defer { entered.continuation.finish() }
                return await owner.performNewChat(request, appModel: host.model, currentPresentation: current)
            }
            do {
                var iterator = entered.stream.makeAsyncIterator()
                _ = try #require(await iterator.next())
                try #require(chat.isCreatingSession)
                #expect(owner.viewModel === chat)
                #expect(owner.transport?.nativeBinding === parent)
                #expect(owner.transport?.gateway === transport.gateway)
                #expect(host.createdSessions == 1)
                let frame = try #require(host.newChatFrames.first)
                #expect(frame["expectedProfileId"] as? String == parent.expectedProfileId)
                let params = try #require(frame["params"] as? [String: Any])
                let childKey = try #require(params["key"] as? String)
                #expect(params["parentSessionKey"] as? String == target.sessionKey)
                #expect(params["agentId"] as? String == host.session().agentID)
                #expect(childKey != target.sessionKey)
                let currentAuthority = chat.captureSessionTransitionAuthority()
                try #require(currentAuthority())
                let historyID = chat.lastIssuedHistoryRequestID
                if retirement == "account-aba" {
                    parent.observe(.verified(profileID: "other-fixture-profile"))
                    parent.observe(.verified(profileID: parent.expectedProfileId))
                    #expect(await parent.isCurrent() == false)
                } else if retirement == "config-aba" {
                    let original = try #require(host.model.activeGatewayConnectConfig)
                    let generation = host.model.operatorAuthorityGeneration
                    host.model.activeGatewayConnectConfig = GatewayConnectConfig(
                        url: original.url, stableID: original.stableID, tls: original.tls,
                        token: "replacement-fixture-account", bootstrapToken: original.bootstrapToken,
                        password: original.password, nodeOptions: original.nodeOptions)
                    host.model.activeGatewayConnectConfig = original
                    #expect(host.model.operatorAuthorityGeneration != generation)
                    #expect(host.model.activeGatewayConnectConfig?.controlUIInputs == original.controlUIInputs)
                }
                #expect(await parent.gateway.currentRoute(ifGatewayID: parent.session.owner.gatewayID) == parent.route)
                await #expect(throws: Error.self) { try await prepared.submit() }
                #expect(host.sent.isEmpty)
                release.continuation.finish()
                let adopted = await creating.value
                #expect(adopted == (retirement == "current"))
                #expect(!chat.isCreatingSession)
                #expect(host.createdSessions == 1)
                #expect(host.newChatFrames.count == 1)
                #expect(!oldAuthority())
                if adopted {
                    let child = try #require(owner.transport?.nativeBinding)
                    #expect(owner.viewModel === chat)
                    #expect(host.binding?.canReuse(child) == true)
                    #expect((chat.transport as? IOSGatewayChatTransport)?.nativeBinding?.canReuse(child) == true)
                    #expect(child.session == .init(
                        owner: parent.session.owner, agentID: parent.session.agentID, sessionKey: childKey))
                    #expect(child.profileObservationID == parent.profileObservationID)
                    #expect(child.route == parent.route && child.gateway === parent.gateway)
                    #expect(await child.isCurrent())
                    #expect(host.model.chatSessionKey == childKey)
                    #expect(chat.currentSessionTarget.sessionKey == childKey)
                    #expect(chat.captureSessionTransitionAuthority()())
                } else {
                    #expect(!currentAuthority())
                    #expect(chat.currentSessionTarget == target)
                    #expect(chat.lastIssuedHistoryRequestID == historyID)
                    #expect(!host.historyKeys.contains(childKey))
                    #expect(host.model.chatSessionKey == target.sessionKey)
                    #expect(owner.currentNewChatRequest(appModel: host.model, presentation: current()) == nil)
                    #expect(await host.router.open(.session(host.session())) == .opened)
                    let successor = try #require(owner.viewModel)
                    let successorBinding = try #require(owner.transport?.nativeBinding)
                    #expect(await successorBinding.isCurrent())
                    #expect(successor.captureSessionTransitionAuthority()())
                    #expect(!currentAuthority())
                    #expect(owner.currentNewChatRequest(appModel: host.model, presentation: current()) == nil)
                    #expect(!host.historyKeys.contains(childKey))
                }
                #expect(host.sent.isEmpty)
                #expect(host.createdSessions == 1)
                entered.continuation.finish()
            } catch {
                release.continuation.finish()
                creating.cancel()
                _ = await creating.value
                entered.continuation.finish()
                throw error
            }
        }
    }

    @Test(arguments: ["readiness", "route"], ["agent", "session", "session-aba", "root", "chat"])
    func `early native preparation cannot adopt a later navigation`(phase: String, departure: String) async throws {
        let session = NativeRouteReadSession()
        defer { session.gate.release()
            session.session.finishTasksAndInvalidate()
        }
        try await self.withHost(sessionBox: phase == "route" ? WebSocketSessionBox(session: session) : nil) { host in
            host.model.setSelectedAgentId("main")
            host.model.focusChatSession("global")
            if departure == "chat" { _ = try await host.openOrdinaryChat() }
            if phase == "readiness" { host.model.setOperatorConnected(false) }
            let reads = host.nativeReads
            let presentations = host.presentations
            let started = AsyncStream<Void>.makeStream()
            let opening = Task {
                // The MainActor observer runs only once open reaches its first await.
                started.continuation.yield(())
                if phase == "route" {
                    return await NativeRouteReadContext.$held.withValue(true) {
                        await host.router.open(.session(host.session()))
                    }
                }
                return await host.router.open(.session(host.session()))
            }
            do {
                var iterator = started.stream.makeAsyncIterator()
                _ = await iterator.next()
                if phase == "route" {
                    let deadline = ContinuousClock.now + .seconds(2)
                    while !session.gate.entered, ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    try #require(session.gate.entered)
                }
                switch departure {
                case "agent": host.model.setSelectedAgentId("research")
                case "session", "session-aba":
                    host.model.focusChatSession("other")
                    if departure == "session-aba" { host.model.focusChatSession("global") }
                case "root":
                    try host.router.unregisterPresentation(#require(host.presentationID))
                    host.presentationID = host.router.registerPresentation(onRetire: { _ in }) { _, _, _ in
                        host.presentations += 1
                    }
                default: try host.hideChat()
                }
                let selectedAgent = host.model.chatDeliveryAgentId
                let selectedSession = host.model.chatSessionKey
                session.gate.release()
                host.model.setOperatorConnected(true)
                #expect(await opening.value == .cancelled)
                #expect(host.model.chatDeliveryAgentId == selectedAgent)
                #expect(host.model.chatSessionKey == selectedSession)
                #expect(host.presentations == presentations)
                #expect(host.nativeReads == reads)
                #expect(host.sent.isEmpty)
                #expect(!session.gate.timedOut)
            } catch {
                session.gate.release()
                opening.cancel()
                _ = await opening.value
                throw error
            }
            started.continuation.finish()
        }
    }

    @Test func `cold root initial focus precedes native preparation authority`() async throws {
        try await self.checkColdRootPreparation(departure: nil)
    }

    @Test(arguments: ["destination", "session-aba", "root-replaced", "root-removed", "cancelled"])
    func `cold native preparation keeps its first registered navigation origin`(departure: String) async throws {
        try await self.checkColdRootPreparation(departure: departure)
    }

    private func checkColdRootPreparation(departure: String?) async throws {
        try await self.withHost { host in
            try host.router.unregisterPresentation(#require(host.presentationID))
            host.presentationID = nil
            let reads = host.nativeReads
            try #require(host.chat == nil)
            let completions = AsyncStream<(Int, OpenClawNativeOpenOutcome)>.makeStream()
            let openings = (0..<2).map { index in
                Task { @MainActor in
                    let result = await host.router.open(.session(host.session()))
                    completions.continuation.yield((index, result))
                    return result
                }
            }
            do {
                var iterator = completions.stream.makeAsyncIterator()
                let first = try #require(await iterator.next())
                // The busy result proves the other task owns preparation while Root
                // is absent; neither task-start order nor a timer establishes that fact.
                try #require(first.1 == .unavailable(
                    reason: "Another native action is opening a chat. Try again when it finishes."))
                let waiting = openings[1 - first.0]
                #expect(host.router.presentationRegistrationID == nil)
                #expect(host.nativeReads == reads)
                if departure == "cancelled" {
                    waiting.cancel()
                    #expect(await waiting.value == .cancelled)
                }
                host.model.focusChatSession("initial-root-session")
                host.registerPresentation()
                let firstRoot = try #require(host.presentationID)
                // Registration and the newer user action share one actor turn. The
                // suspended opener cannot resume between these authoritative events.
                switch departure {
                case "destination":
                    try #require(host.router.userNavigationDidChange(presentationID: firstRoot))
                case "session-aba":
                    host.model.focusChatSession("newer-user-choice")
                    host.model.focusChatSession("initial-root-session")
                case "root-replaced", "root-removed":
                    host.router.unregisterPresentation(firstRoot)
                    host.presentationID = nil
                    if departure == "root-replaced" { host.registerPresentation() }
                default: break
                }
                let selectedAgent = host.model.chatDeliveryAgentId
                let selectedSession = host.model.chatSessionKey
                let result = await waiting.value
                if departure == nil {
                    #expect(result == .opened)
                    #expect(host.binding?.session == host.session())
                    #expect(host.presentations == 1)
                } else {
                    #expect(result == .cancelled)
                    #expect(host.model.chatDeliveryAgentId == selectedAgent)
                    #expect(host.model.chatSessionKey == selectedSession)
                    #expect(host.presentations == 0)
                    #expect(host.chat == nil)
                    #expect(host.nativeReads == reads)
                    #expect(host.sent.isEmpty)
                    #expect(host.createdSessions == 0)
                    if host.presentationID == nil { host.registerPresentation() }
                    #expect(await host.router.open(.session(host.session())) == .opened)
                    #expect(host.presentations == 1)
                    #expect(host.binding?.session == host.session())
                }
                for task in openings {
                    _ = await task.value
                }
                completions.continuation.finish()
            } catch {
                for task in openings {
                    task.cancel()
                }
                for task in openings {
                    _ = await task.value
                }
                completions.continuation.finish()
                throw error
            }
        }
    }

    @Test(arguments: ["cold-root-user", "early-user", "history-projection", "history-user", "history-aba"])
    func `saved Gateway preparation waits for its physical route without adopting navigation`(
        interruption: String) async throws
    {
        let stateDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("native-saved-gateway-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDirectory) }
        try await DeviceIdentityStore.withStateDirectory(stateDirectory) {
            try await withUserDefaults(["push.apns.deviceTokenHex": nil, "gateway.autoconnect": false]) {
                try await self.withHost(foreground: true) { host in
                    let registry = GatewayRegistryTestIsolation()
                    defer { registry.restore() }
                    let destination = Host()
                    let fixture = try await destination.startFixture(acceptsStartup: true)
                    let gatewayID = "manual|127.0.0.1|\(fixture.port)"
                    let instanceID = GatewaySettingsStore.currentInstanceID()
                    defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID, stableID: gatewayID) }
                    let release = AsyncStream<Void>.makeStream()
                    var opening: Task<OpenClawNativeOpenOutcome, Never>?
                    var competingOpening: Task<OpenClawNativeOpenOutcome, Never>?
                    let outcome: Result<Void, Error>
                    do {
                        try #require(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
                            stableID: gatewayID, kind: .manual, name: "Saved fixture Gateway",
                            host: "127.0.0.1", port: Int(fixture.port), useTLS: false, lastConnectedAtMs: nil)))
                        try #require(GatewaySettingsStore.saveGatewayCredentials(
                            token: "fixture-b-token", bootstrapToken: nil, password: nil,
                            gatewayStableID: gatewayID, suppressStoredDeviceAuth: true, instanceId: instanceID))
                        #expect(await host.router.open(.session(host.session())) == .opened)
                        let initialBinding = try #require(host.binding)
                        let initialReads = host.nativeReads
                        let initialPresentations = host.presentations
                        var historyInterruptionApplied = false
                        var bindingAtHistory: IOSNativeActionBinding?
                        var userNavigationAccepted = false
                        var selectedAfterInterruption: (agent: String?, session: String)?
                        if interruption != "early-user", interruption != "cold-root-user" {
                            destination.beforeResponse = { method in
                                // Profiled reads are recorded immediately before this callback.
                                // Ordinary startup history cannot satisfy this first native pair.
                                guard method == "chat.history",
                                      destination.nativeReads == ["users.self", "chat.history"]
                                else { return }
                                destination.beforeResponse = nil
                                historyInterruptionApplied = true
                                bindingAtHistory = host.binding
                                switch interruption {
                                case "history-projection":
                                    host.router.retireChatSelection(presentationID: host.presentationID)
                                case "history-user":
                                    userNavigationAccepted = host.router.userNavigationDidChange(
                                        presentationID: host.presentationID)
                                default:
                                    let originalSession = host.model.chatSessionKey
                                    host.model.focusChatSession("chosen-during-history")
                                    host.model.focusChatSession(originalSession)
                                }
                                // Gateway hydration can resolve the delivery owner; explicit
                                // user selection must remain unchanged.
                                selectedAfterInterruption = (host.model.selectedAgentId, host.model.chatSessionKey)
                            }
                        }
                        host.model._test_setGatewaySessionResetTask(Task {
                            for await _ in release.stream {
                                return
                            }
                        })
                        let route = try #require(await host.model.operatorSession.currentRoute())
                        let target = OpenClawNativeSessionRef(
                            owner: .init(gatewayID: gatewayID, profileID: "alice"),
                            agentID: "main", sessionKey: "global")
                        if interruption == "cold-root-user" {
                            try host.router.unregisterPresentation(#require(host.presentationID))
                            host.presentationID = nil
                            let generation = host.model.gatewayConnectGeneration
                            let capturedChat = try #require(host.chat)
                            let capturedTarget = capturedChat.currentSessionTarget
                            let capturedInput = capturedChat.input
                            let completions = AsyncStream<(Int, OpenClawNativeOpenOutcome)>.makeStream()
                            var completedOpenings: [Int: OpenClawNativeOpenOutcome] = [:]
                            defer { completions.continuation.finish() }
                            let first = Task { @MainActor in
                                let result = await host.router.open(.session(target))
                                completedOpenings[0] = result
                                completions.continuation.yield((0, result))
                                return result
                            }
                            opening = first
                            let second = Task { @MainActor in
                                let result = await host.router.open(.session(target))
                                completedOpenings[1] = result
                                completions.continuation.yield((1, result))
                                return result
                            }
                            competingOpening = second
                            var iterator = completions.stream.makeAsyncIterator()
                            let busy = try #require(await iterator.next())
                            try #require(busy.1 == .unavailable(
                                reason: "Another native action is opening a chat. Try again when it finishes."))
                            host.registerPresentation()
                            try #require(host.router.userNavigationDidChange(presentationID: host.presentationID))
                            let resumeDeadline = ContinuousClock.now + .seconds(2)
                            while completedOpenings.count < 2, !host.controller.hasPendingConnectionHandoff,
                                  ContinuousClock.now < resumeDeadline
                            {
                                try await Task.sleep(for: .milliseconds(10))
                            }
                            // A wrong handoff is itself the failure signal; cleanup releases
                            // its reset before joining, without waiting for the router deadline.
                            try #require(!host.controller.hasPendingConnectionHandoff)
                            try #require(completedOpenings.count == 2)
                            let pending = busy.0 == 0 ? second : first
                            #expect(await pending.value == .cancelled)
                            _ = await first.value
                            _ = await second.value
                            // The retired cold action must be rejected before requesting a
                            // real saved-Gateway handoff, even while its reset is held.
                            #expect(!host.controller.hasPendingConnectionHandoff)
                            #expect(host.model.gatewayConnectGeneration == generation)
                            #expect(host.model.activeGatewayConnectConfig?.effectiveStableID == host.gatewayID)
                            #expect(await host.model.operatorSession.currentRoute() == route)
                            #expect(host.nativeReads == initialReads)
                            #expect(destination.nativeReads.isEmpty)
                            #expect(host.presentations == initialPresentations)
                            #expect(host.chat === capturedChat)
                            #expect(capturedChat.currentSessionTarget == capturedTarget)
                            #expect(capturedChat.input == capturedInput)
                            #expect(host.sent.isEmpty && destination.sent.isEmpty)
                            #expect(host.createdSessions == 0 && destination.createdSessions == 0)
                            release.continuation.finish()
                            #expect(await host.router.open(.session(host.session())) == .opened)
                        } else {
                            let task = Task { await host.router.open(.session(target)) }
                            opening = task
                            let deadline = ContinuousClock.now + .seconds(2)
                            while !host.controller.hasPendingConnectionHandoff, ContinuousClock.now < deadline {
                                try await Task.sleep(for: .milliseconds(10))
                            }
                            try #require(host.controller.hasPendingConnectionHandoff)
                            // Acceptance queues the reset; the old socket remains genuinely connected.
                            #expect(host.model.isOperatorGatewayConnected)
                            #expect(host.model.activeGatewayConnectConfig?.effectiveStableID == host.gatewayID)
                            #expect(await host.model.operatorSession.currentRoute() == route)
                            #expect(host.nativeReads == initialReads)
                            if interruption == "early-user" {
                                host.model.focusChatSession("chosen-during-handoff")
                            }
                            release.continuation.finish()
                            let result = await task.value
                            #expect(host.nativeReads == initialReads)
                            #expect(host.sent.isEmpty)
                            #expect(destination.sent.isEmpty)
                            #expect(host.createdSessions == 0)
                            #expect(destination.createdSessions == 0)
                            #expect(historyInterruptionApplied == (interruption != "early-user"))
                            if interruption == "early-user" {
                                #expect(result == .cancelled)
                                #expect(host.presentations == initialPresentations)
                                #expect(destination.nativeReads.isEmpty)
                            } else {
                                #expect(bindingAtHistory === initialBinding)
                                #expect(host.model.activeGatewayConnectConfig?.effectiveStableID == gatewayID)
                                #expect(host.model.isOperatorGatewayConnected)
                                #expect(await host.model.operatorSession.currentRoute(ifGatewayID: gatewayID) != nil)
                                if interruption == "history-projection" {
                                    #expect(result == .opened)
                                    #expect(host.presentations == initialPresentations + 1)
                                    #expect(host.binding?.session == target)
                                    #expect(destination.nativeReads.contains("users.self"))
                                    #expect(destination.nativeReads.contains("chat.history"))
                                } else {
                                    #expect(result == .cancelled)
                                    #expect(host.presentations == initialPresentations)
                                    #expect(destination.nativeReads == ["users.self", "chat.history"])
                                    #expect(userNavigationAccepted == (interruption == "history-user"))
                                    let selected = try #require(selectedAfterInterruption)
                                    #expect(host.model.selectedAgentId == selected.agent)
                                    #expect(host.model.chatSessionKey == selected.session)
                                }
                            }
                        }
                        outcome = .success(())
                    } catch {
                        outcome = .failure(error)
                    }
                    release.continuation.finish()
                    host.model.disconnectGateway()
                    await host.model.waitForGatewaySessionResetIfNeeded()
                    let shutdownDeadline = ContinuousClock.now + .seconds(2)
                    while host.controller.hasPendingConnectionHandoff, ContinuousClock.now < shutdownDeadline {
                        try? await Task.sleep(for: .milliseconds(10))
                    }
                    #expect(!host.controller.hasPendingConnectionHandoff)
                    opening?.cancel()
                    competingOpening?.cancel()
                    _ = await opening?.value
                    _ = await competingOpening?.value
                    await host.model.purgeChatTranscriptCache(gatewayID: gatewayID)
                    await destination.close()
                    #expect(
                        destination.callbackViolationCount == 0,
                        "\(destination.callbackViolations.joined(separator: " | "))")
                    try outcome.get()
                }
            }
        }
    }

    @Test(arguments: [false, true])
    func `hidden retained drafts refuse another agent before changing selection`(native: Bool) async throws {
        try await self.withHost { host in
            let chat: OpenClawChatViewModel
            if native {
                #expect(await host.router.open(.session(host.session())) == .opened)
                chat = try #require(host.chat)
            } else {
                chat = try await host.openOrdinaryChat()
            }
            let owner = host.model.chatPresentation
            let binding = owner.transport?.nativeBinding
            let target = chat.currentSessionTarget
            chat.input = "Keep this hidden draft"
            try host.hideChat()
            owner.sync(appModel: host.model)
            let retired = host.retired
            let presentations = host.presentations
            let config = host.model.activeGatewayConnectConfig?.controlUIInputs
            let route = await host.model.operatorSession.currentRoute()

            #expect(await host.router.open(.session(host.session("research"))) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(owner.viewModel === chat)
            #expect(owner.transport?.nativeBinding === binding)
            #expect(chat.currentSessionTarget == target)
            #expect(chat.input == "Keep this hidden draft")
            #expect(!chat.isQuestionAuthorityRetired)
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.model.activeGatewayConnectConfig?.controlUIInputs == config)
            #expect(await host.model.operatorSession.currentRoute() == route)
            #expect(host.chatRegistrationID == nil)
            #expect(host.binding == nil)
            #expect(host.presentations == presentations)
            #expect(host.retired == retired)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test func `hidden ordinary draft refuses replacement by a native binding on the same target`() async throws {
        try await self.withHost { host in
            let chat = try await host.openOrdinaryChat()
            chat.input = "Ordinary composer draft"
            try host.hideChat()
            host.model.chatPresentation.sync(appModel: host.model)
            #expect(await host.router.open(.session(host.session())) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(host.model.chatPresentation.viewModel === chat)
            #expect(host.model.chatPresentation.transport?.nativeBinding == nil)
            #expect(chat.input == "Ordinary composer draft")
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.presentations == 0)
            #expect(host.chatRegistrationID == nil)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test func `hidden ordinary draft refuses a saved Gateway before persisting a switch`() async throws {
        try await self.withHost { host in
            let chat = try await host.openOrdinaryChat()
            chat.input = "Stay with the original Gateway"
            try host.hideChat()
            host.model.chatPresentation.sync(appModel: host.model)
            let isolation = GatewayRegistryTestIsolation()
            defer { isolation.restore() }
            let otherGateway = "manual|127.0.0.1|2"
            #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
                stableID: otherGateway, kind: .manual, name: "Other test Gateway",
                host: "127.0.0.1", port: 2, useTLS: false, lastConnectedAtMs: nil)))
            let registry = GatewaySettingsStore.loadGatewayRegistry()
            let config = host.model.activeGatewayConnectConfig?.controlUIInputs
            let route = await host.model.operatorSession.currentRoute()
            let generation = host.model.gatewayConnectGeneration
            let target = OpenClawNativeSessionRef(
                owner: .init(gatewayID: otherGateway, profileID: "alice"),
                agentID: "main", sessionKey: "global")

            #expect(await host.router.open(.session(target)) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(GatewaySettingsStore.loadGatewayRegistry() == registry)
            #expect(host.model.activeGatewayConnectConfig?.controlUIInputs == config)
            #expect(await host.model.operatorSession.currentRoute() == route)
            #expect(host.model.gatewayConnectGeneration == generation)
            #expect(host.model.chatPresentation.viewModel === chat)
            #expect(host.model.chatPresentation.transport?.nativeBinding == nil)
            #expect(chat.input == "Stay with the original Gateway")
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.presentations == 0)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test func `draft arriving in a hidden owner during history refuses the verified replacement`() async throws {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let owner = host.model.chatPresentation
            let chat = try #require(owner.viewModel)
            let binding = try #require(owner.transport?.nativeBinding)
            let target = chat.currentSessionTarget
            try host.hideChat()
            let presentations = host.presentations
            host.beforeResponse = { method in
                guard method == "chat.history" else { return }
                host.beforeResponse = nil
                chat.input = "Draft typed while history was loading"
                owner.sync(appModel: host.model)
            }

            #expect(await host.router.open(.session(host.session("research"))) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(host.beforeResponse == nil)
            #expect(owner.viewModel === chat)
            #expect(owner.transport?.nativeBinding === binding)
            #expect(chat.currentSessionTarget == target)
            #expect(chat.input == "Draft typed while history was loading")
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.presentations == presentations)
            #expect(host.chatRegistrationID == nil)
            #expect(host.binding == nil)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test(arguments: ["text", "attachment", "capture"])
    func `retained native composer refuses replacement and reuses the same target`(
        composer: String) async throws
    {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let chat = try #require(host.chat)
            let binding = try #require(host.binding)
            if composer == "text" { chat.input = "Keep the same composer" }
            if composer == "attachment" {
                chat.attachments = [.init(
                    url: nil, data: Data("fixture".utf8), fileName: "fixture.txt", mimeType: "text/plain",
                    preview: nil)]
            }
            if composer == "capture" { host.model.acquirePttVoiceWakeLease(for: "native-draft-test") }
            defer { host.model.releasePttVoiceWakeLease(for: "native-draft-test") }
            let attachments = chat.attachments.map(\.id)
            try host.hideChat()
            // Text and attachments survive RootTabs' ordinary synchronization too.
            // Capture admission is checked in the interval before that task runs.
            if composer != "capture" { host.model.chatPresentation.sync(appModel: host.model) }

            #expect(await host.router.open(.session(host.session("research"))) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(await host.router.open(.session(host.session())) == .opened)
            #expect(host.chat === chat)
            #expect(host.model.chatPresentation.transport?.nativeBinding === binding)
            #expect(host.binding?.canReuse(binding) == true)
            #expect(chat.input == (composer == "text" ? "Keep the same composer" : ""))
            #expect(chat.attachments.map(\.id) == attachments)
            #expect(host.chatRegistrationID != nil)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test func `native admission protects an unregistered send until its reply joins`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            let reply = AsyncStream<Void>.makeStream()
            host.deferredSendReply = {
                for await _ in reply.stream {
                    return
                }
            }
            let send = Task { try await prepared.submit() }
            do {
                let deadline = ContinuousClock.now + .seconds(2)
                while host.sent.isEmpty, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(host.sent.count == 1)
                #expect(chat.input.isEmpty)
                #expect(!chat.canPreserveIdleTextDraft)
                // Exercise native admission before RootTabs' ordinary sync task;
                // unregister alone does not settle or transfer this accepted send.
                try host.hideChat()
                let presentations = host.presentations
                #expect(await host.router.open(.session(host.session("research"))) == .unavailable(
                    reason: "Keep or send the current draft before opening a different session."))
                #expect(host.chat === chat)
                #expect(host.model.chatDeliveryAgentId == "main")
                #expect(host.model.chatSessionKey == "global")
                #expect(host.presentations == presentations)
                reply.continuation.finish()
                #expect(try await send.value.runID == "run-1")
                #expect(host.sent.count == 1)
                #expect(host.createdSessions == 0)
            } catch {
                reply.continuation.finish()
                _ = try? await send.value
                throw error
            }
        }
    }

    @Test(arguments: [false, true])
    func `native account replacement retires questions even when composer adoption is refused`(
        restoresOriginalAccount: Bool) async throws
    {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let owner = host.model.chatPresentation
            let chat = try #require(owner.viewModel)
            let binding = try #require(owner.transport?.nativeBinding)
            let original = try #require(host.model.activeGatewayConnectConfig)
            let target = chat.currentSessionTarget
            let attachment = OpenClawPendingAttachment(
                url: nil, data: Data("fixture".utf8), fileName: "fixture.txt", mimeType: "text/plain", preview: nil)
            chat.attachments = [attachment]
            chat.input = "Keep this native draft with its attachment"
            chat.upsertQuestion(QuestionRecord(
                id: "native-account-question",
                questions: [Question(
                    questionid: "choice", header: "Choice", question: "Choose the deployment target",
                    options: [QuestionOption(label: "Staging")])],
                createdatms: 1, expiresatms: Int.max, status: .pending))
            host.model.activeGatewayConnectConfig = GatewayConnectConfig(
                url: original.url, stableID: original.stableID, tls: original.tls,
                token: "synthetic-replacement", bootstrapToken: original.bootstrapToken,
                password: original.password, nodeOptions: original.nodeOptions)

            #expect(!owner.canPresentNativeSession(binding.session, appModel: host.model, binding: binding))
            #expect(!chat.isQuestionAuthorityRetired)
            #expect(chat.questionCards.map(\.id) == ["native-account-question"])
            owner.sync(
                appModel: host.model, nativeBinding: binding,
                nativeActions: host.router, presentationID: host.presentationID)
            #expect(chat.isQuestionAuthorityRetired)
            #expect(chat.questionCards.isEmpty)
            #expect(owner.viewModel === chat)
            #expect(owner.transport?.nativeBinding === binding)
            #expect(chat.currentSessionTarget == target)
            #expect(chat.input == "Keep this native draft with its attachment")
            #expect(chat.attachments.map(\.id) == [attachment.id])
            if restoresOriginalAccount {
                host.model.activeGatewayConnectConfig = original
                owner.sync(
                    appModel: host.model, nativeBinding: binding,
                    nativeActions: host.router, presentationID: host.presentationID)
                #expect(owner.viewModel === chat)
                #expect(chat.isQuestionAuthorityRetired)
                #expect(chat.questionCards.isEmpty)
                #expect(chat.input == "Keep this native draft with its attachment")
                #expect(chat.attachments.map(\.id) == [attachment.id])
            }
            chat.removeAttachment(attachment.id)
            #expect(!chat.isAttachmentOwnerPinned)
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test(arguments: ["open owner", "open history", "prepare owner", "confirmation", "catalog"])
    func `captured owner observations retire cached authority without a broadcast`(stage: String) async throws {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let original = try #require(host.binding)
            let sibling = try await IOSNativeActionBinding.capture(
                session: original.session, gateway: original.gateway, route: original.route,
                reservation: original.reserveRetirement())
            let transport = IOSGatewayChatTransport(gateway: original.gateway, nativeBinding: original)
            let scoped = try #require(transport.scoped(toAgentID: "research") as? IOSGatewayChatTransport)
            let path = "/__openclaw__/canvas/documents/test/index.html"
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: nil) != nil)
            #expect(host.widgetRefreshes == 1)
            let prepared = stage == "confirmation" ? try await host.prepare() : nil
            if stage == "catalog" {
                host.catalogDiscovery = true
                host.profileID = "bob"
                let choices = try await host.router.sessions(matching: nil)
                #expect(!choices.isEmpty)
                #expect(choices.allSatisfy { $0.session.owner.profileID == "bob" })
            } else {
                host.rejectMethod = stage == "open history" ? "chat.history" : "users.self"
                host.requestsBeforeRejection = stage == "prepare owner" ? 1 : 0
                if stage == "open owner" || stage == "open history" {
                    guard case .unavailable = await host.router.open(.session(host.session())) else {
                        Issue.record("The captured verification must report the refused owner")
                        return
                    }
                } else {
                    do {
                        if let prepared { _ = try await prepared.submit() } else { _ = try await host.prepare() }
                        Issue.record("The owner refusal must prevent preparation or confirmation")
                    } catch let error as GatewayResponseError {
                        #expect(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
                        #expect(error.details["execution"]?.stringValue == "not_started")
                    }
                }
                #expect(host.rejectMethod == nil)
            }
            #expect(await original.gateway.currentRoute() == original.route)
            #expect(await original.isCurrent() == false)
            #expect(await sibling.isCurrent() == false)
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(await scoped.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(host.widgetRefreshes == 1)
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: [false, true])
    func `retained confirmations retire a different session's warm account authority`(
        unregister: Bool) async throws
    {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let original = try #require(host.binding)
            let originalChat = try #require(host.chat)
            if unregister {
                host.router.unregisterChat(host.chatRegistrationID)
                originalChat.detachTransport()
            }
            #expect(await host.router.open(.session(host.session("research"))) == .opened)
            let current = try #require(host.binding)
            #expect(host.chat !== originalChat)
            #expect(original.session != current.session)
            #expect(!original.canReuse(current))
            let transport = IOSGatewayChatTransport(gateway: current.gateway, nativeBinding: current)
            let scoped = try #require(transport.scoped(toAgentID: "main") as? IOSGatewayChatTransport)
            let path = "/__openclaw__/canvas/documents/test/index.html"
            let warm = try #require(await transport.resolveInlineWidgetResource(path: path, replacing: nil))
            #expect(host.widgetRefreshes == 1)

            host.rejectMethod = "users.self"
            do {
                _ = try await prepared.submit()
                Issue.record("The retained confirmation must preserve its account refusal")
            } catch let error as GatewayResponseError {
                #expect(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
                #expect(error.details["execution"]?.stringValue == "not_started")
            }
            #expect(host.rejectMethod == nil)
            #expect(await original.gateway.currentRoute() == original.route)
            #expect(await original.isCurrent() == false)
            #expect(await current.isCurrent() == false)
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(await scoped.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(host.widgetRefreshes == 1)

            #expect(await host.router.open(.session(host.session("research"))) == .opened)
            let fresh = try #require(host.binding)
            #expect(fresh.profileObservationID != current.profileObservationID)
            #expect(await fresh.isCurrent())
            host.rejectMethod = "users.self"
            do {
                _ = try await prepared.submit()
                Issue.record("The old confirmation must remain refused after a fresh capture")
            } catch let error as GatewayResponseError {
                #expect(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
                #expect(error.details["execution"]?.stringValue == "not_started")
            }
            #expect(host.rejectMethod == nil)
            #expect(await fresh.isCurrent())
            let freshTransport = IOSGatewayChatTransport(gateway: fresh.gateway, nativeBinding: fresh)
            #expect(await freshTransport.resolveInlineWidgetResource(path: path, replacing: nil)?.url == warm.url)
            #expect(host.widgetRefreshes == 1)
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: ["users.self", "chat.history"])
    func `retirement during initial verification cannot admit a fresh account lifetime`(method: String) async throws {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let original = try #require(host.binding)
            let originalChat = try #require(host.chat)
            let rosterRequests = host.rosterRequests
            let retired = host.retired
            host.beforeResponse = { received in
                guard received == method else { return }
                host.beforeResponse = nil
                original.observe(.rejected(expectedProfileID: original.expectedProfileId))
            }

            let outcome = await host.router.open(.session(host.session("research")))
            #expect(outcome == .unavailable(
                reason: GatewayNodeSessionRequestError.routeChangedBeforeDispatch.localizedDescription))
            #expect(host.beforeResponse == nil)
            #expect(await original.isCurrent() == false)
            #expect(await original.gateway.currentRoute() == original.route)
            #expect(host.binding === original)
            #expect(host.chat === originalChat)
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.retired == retired)
            #expect(host.rosterRequests == rosterRequests)

            #expect(await host.router.open(.session(host.session("research"))) == .opened)
            let fresh = try #require(host.binding)
            #expect(fresh.session == host.session("research"))
            #expect(fresh.profileObservationID != original.profileObservationID)
            #expect(await fresh.isCurrent())
            #expect(host.rosterRequests == rosterRequests + 1)
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: ["first preparation", "first confirmation", "reopened confirmation"])
    func `new presentations observe their own subsequent account refusals`(stage: String) async throws {
        try await self.withHost { host in
            let prepared: OpenClawNativePreparedSend?
            if stage == "first preparation" {
                host.requestsBeforeRejection = 1
                prepared = nil
            } else {
                if stage == "reopened confirmation" {
                    _ = try await host.prepare()
                    let original = try #require(host.binding)
                    original.observe(.verified(profileID: "bob"))
                    #expect(await original.isCurrent() == false)
                }
                prepared = try await host.prepare()
                let binding = try #require(host.binding)
                #expect(await binding.isCurrent())
                let transport = IOSGatewayChatTransport(gateway: binding.gateway, nativeBinding: binding)
                #expect(await transport.resolveInlineWidgetResource(
                    path: "/__openclaw__/canvas/documents/test/index.html", replacing: nil) != nil)
            }
            host.rejectMethod = "users.self"
            do {
                if let prepared { _ = try await prepared.submit() } else { _ = try await host.prepare() }
                Issue.record("The new presentation must preserve its owner's typed refusal")
            } catch let error as GatewayResponseError {
                #expect(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
                #expect(error.details["execution"]?.stringValue == "not_started")
            }
            #expect(host.rejectMethod == nil)
            let binding = try #require(host.binding)
            #expect(await binding.isCurrent() == false)
            let transport = IOSGatewayChatTransport(gateway: binding.gateway, nativeBinding: binding)
            let refreshes = host.widgetRefreshes
            #expect(await transport.resolveInlineWidgetResource(
                path: "/__openclaw__/canvas/documents/test/index.html", replacing: nil) == nil)
            #expect(host.widgetRefreshes == refreshes)
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `same-key agent navigation retires old confirmations even after returning`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            let unchanged = host.retired
            let originalBinding = try #require(host.binding)
            let originalAuthority = try #require(host.router.capturePresentationAuthority(host.presentationID))
            host.model.focusChatSession(chat.currentSessionTarget)
            #expect(host.retired == unchanged)
            chat.switchSession(to: "global", agentID: "research")
            #expect(host.model.chatDeliveryAgentId == "research")
            let successorBinding = try #require(host.binding)
            #expect(successorBinding.session == host.session("research"))
            #expect(successorBinding !== originalBinding)
            #expect(!host.router.isCurrentPresentation(originalAuthority))
            #expect(chat.currentSessionTarget == OpenClawChatSessionTarget(sessionKey: "global", agentID: "research"))
            #expect(host.retired > unchanged)
            chat.switchSession(to: "global", agentID: "main")
            #expect(host.model.chatDeliveryAgentId == "main")
            await #expect(throws: Error.self) { _ = try await prepared.submit() }
            #expect(host.sent.isEmpty)
            let fresh = try await host.prepare()
            #expect(try await fresh.submit().session == host.session())
            #expect(host.sent.count == 1)
        }
    }

    @Test func `old model callbacks cannot retire a successor and modal rejection preserves selection`() async throws {
        try await self.withHost { host in
            _ = try await host.prepare()
            let oldChat = try #require(host.chat)
            let research = try await host.prepare("research")
            let current = try #require(host.binding)
            let retired = host.retired
            oldChat.switchSession(to: "agent:main:old-callback")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.model.chatDeliveryAgentId == "research")
            #expect(host.binding?.canReuse(current) == true)
            #expect(host.retired == retired)
            host.rejectPresentation = true
            #expect(await host.router.open(.session(host.session())) == .cancelled)
            #expect(host.model.chatDeliveryAgentId == "research")
            host.rejectPresentation = false
            #expect(try await research.submit().session == host.session("research"))
            #expect(host.sent.count == 1)
            #expect(host.sent.first?["agentId"] as? String == "research")
        }
    }

    @Test func `native search sends an older same-agent session omitted by the bootstrap roster`() async throws {
        try await self.withHost { host in
            let selected = host.session()
            let recent: [[String: Any]] = (0..<51).map { index in
                [
                    "key": "agent:main:recent-\(index)", "agentId": "main",
                    "displayName": "Recent \(index)", "updatedAt": 1000 - index,
                    "permissionMode": "full", "toolOverrides": ["webSearch": true],
                ]
            }
            host.boundedSessionRows = recent + [[
                "key": selected.sessionKey, "agentId": selected.agentID, "displayName": "Older target",
                "updatedAt": 1, "permissionMode": "guarded", "toolOverrides": [:],
            ]]
            host.catalogDiscovery = true
            let choices = try await host.router.sessions(matching: "Older target")
            host.catalogDiscovery = false
            #expect(choices.count == 1)
            let choice = try #require(choices.first)
            #expect(choice.session == selected)
            let prepared = try await host.router.prepareSend(to: choice.session, message: "one older-session action")
                .send
            let chat = try #require(host.chat)
            #expect(chat.hasCurrentSessionMetadata)
            #expect(chat.sessions.count == 50)
            #expect(chat.sessions.allSatisfy { $0.agentId == selected.agentID })
            #expect(!chat.sessions.contains { $0.key == selected.sessionKey })
            #expect(host.boundedSessionListRequests.contains {
                $0["limit"] as? Int == 50 && $0["search"] == nil && $0["agentId"] as? String == selected.agentID
            })
            #expect(host.sent.isEmpty)
            let route = await host.model.operatorSession.currentRoute()
            let result = try await prepared.submit()
            #expect(result.session == selected)
            #expect(host.sent.count == 1)
            #expect(host.sent.first?["sessionKey"] as? String == selected.sessionKey)
            #expect(host.sent.first?["agentId"] as? String == selected.agentID)
            #expect(host.sent.first?["expectedPermissionMode"] as? String == "guarded")
            #expect((host.sent.first?["expectedToolOverrides"] as? [String: Any])?.isEmpty == true)
            #expect(!chat.sessions.contains { $0.key == selected.sessionKey })
            #expect(await host.model.operatorSession.currentRoute() == route)
            #expect(host.binding?.session == selected)
            #expect(host.createdSessions == 0)
        }
    }

    @Test(arguments: [false, true])
    func `confirmation exposes the captured message that submission retains`(long: Bool) async throws {
        try await self.withHost { host in
            let message = " \tFirst e\u{301} 🦊\n" +
                (long ? String(repeating: "A longer captured line e\u{301}\n", count: 300) : "Second line\n")
            let prepared = try await host.router.prepareSend(to: host.session(), message: message).send
            #expect(prepared.message.utf8.elementsEqual(message.utf8))
            #expect(host.sent.isEmpty)
            let chat = try #require(host.chat)
            chat.input = "A different composer draft"
            let run = try await prepared.submit()
            #expect(run.session == host.session())
            #expect(host.sent.count == 1)
            let sent = try #require(host.sent.first?["message"] as? String)
            #expect(sent.utf8.elementsEqual(message.trimmingCharacters(in: .whitespacesAndNewlines).utf8))
            #expect(prepared.message.utf8.elementsEqual(message.utf8))
            #expect(chat.input == "A different composer draft")
        }
    }

    @Test(arguments: [false, true])
    func `presentation retirement clears host state in either view teardown order`(childFirst: Bool) async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let registrationID = try #require(host.chatRegistrationID)
            let binding = try #require(host.binding)
            let presentationID = try #require(host.presentationID)
            if childFirst { host.router.unregisterChat(registrationID) }
            host.router.unregisterPresentation(presentationID)
            if !childFirst { host.router.unregisterChat(registrationID) }
            #expect(host.binding == nil)
            #expect(host.receipt == nil)
            #expect(await binding.isCurrent())
            do {
                _ = try await prepared.submit()
                Issue.record("The retired presentation must reject its retained confirmation")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message == "The action route changed. Select the session again.")
            }
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: [false, true])
    func `stale visible chat registration cannot retire a successor on the same model`(native: Bool) async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            let binding = try #require(host.binding)
            let transport = IOSGatewayChatTransport(
                gateway: host.model.operatorSession, nativeBinding: native ? binding : nil)
            let original = try #require(host.router.registerChat(
                chat, ownerID: host.model.chatViewModelOwnerID, agentID: host.session().agentID,
                transport: transport, presentationID: host.presentationID))
            let successor = try #require(host.router.registerChat(
                chat, ownerID: host.model.chatViewModelOwnerID, agentID: host.session().agentID,
                transport: transport, presentationID: host.presentationID))
            #expect(original != successor)
            let retired = host.retired
            host.router.unregisterChat(original)
            #expect(host.retired == retired)
            #expect(host.binding === binding)
            if native {
                #expect(try await prepared.submit().session == host.session())
                #expect(host.sent.count == 1)
            }
            host.router.unregisterChat(successor)
            #expect(host.retired == retired + 1)
            #expect(host.binding == nil)
            host.router.unregisterChat(successor)
            #expect(host.retired == retired + 1)
        }
    }

    @Test func `session transition authority cannot revive when the same retained chat registers again`() async throws {
        try await self.withHost { host in
            _ = try await host.prepare()
            let chat = try #require(host.chat)
            let binding = try #require(host.binding)
            let presentationID = try #require(host.presentationID)
            let transport = IOSGatewayChatTransport(gateway: host.model.operatorSession, nativeBinding: binding)
            let target = chat.currentSessionTarget
            let captured = host.router.captureSessionTransitionAuthority(
                chat, binding: binding, presentationID: presentationID)
            #expect(captured())
            host.router.unregisterChat(host.chatRegistrationID)
            #expect(!captured())
            host.chatRegistrationID = host.router.registerChat(
                chat, ownerID: host.model.chatViewModelOwnerID, agentID: host.session().agentID,
                transport: transport, presentationID: presentationID)
            #expect(chat.currentSessionTarget == target)
            #expect(await binding.isCurrent())
            #expect(!captured())
            let reopened = host.router.captureSessionTransitionAuthority(
                chat, binding: binding, presentationID: presentationID)
            #expect(reopened())
            host.router.unregisterPresentation(presentationID)
            #expect(!reopened())
            #expect(await binding.isCurrent())
        }
    }

    @Test(arguments: ["warm", "hidden", "ownSync", "selectionABA", "root", "route", "afterRefresh"])
    func `prepared sidebar fork cannot replace a newer same target native inspection`(mode: String) async throws {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let chat = try #require(host.chat)
            chat.input = "Retained draft"
            if mode != "warm" {
                try host.hideChat()
                host.model.chatPresentation.sync(appModel: host.model)
                #expect(host.chat === chat)
            }
            let root = try #require(host.presentationID)
            #expect(host.router.userNavigationDidChange(presentationID: root))
            #expect(host.binding == nil)
            var parentSession = OpenClawChatSessionEntry.placeholder(key: "global")
            parentSession.agentId = "main"
            // Capture before #require so its macro preserves the actor-isolated callback types.
            let navigation = PreparedChatNavigation.capture(
                appModel: host.model, router: host.router, presentationID: root,
                session: parentSession, isCurrentContext: { true },
                currentNativeBinding: { host.binding }, open: { target in
                    host.model.focusChatSession(target)
                    host.model.openChat(sessionKey: target.sessionKey)
                })
            let captured = try #require(navigation)
            let entered = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
            let release = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
            let forkReturned = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
            let commitRelease = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
            defer {
                entered.continuation.finish()
                release.continuation.finish()
                forkReturned.continuation.finish()
                commitRelease.continuation.finish()
            }
            host.deferredForkReply = {
                entered.continuation.yield(())
                for await _ in release.stream {
                    break
                }
            }
            let fork = Task {
                let result = try await captured.fork(fromLastCompleted: false)
                if mode == "afterRefresh" {
                    forkReturned.continuation.yield(())
                    for await _ in commitRelease.stream {
                        break
                    }
                }
                return await captured.commit(result)
            }
            var inspecting: Task<OpenClawNativeRunInspection, Error>?
            do {
                try await AsyncTimeout.withTimeout(seconds: 2, onTimeout: { URLError(.timedOut) }) {
                    for await _ in entered.stream {
                        break
                    }
                }
                if mode == "ownSync" {
                    host.model.chatPresentation.sync(appModel: host.model)
                    #expect(host.binding == nil)
                    #expect(host.chat === chat)
                    #expect(captured.isCurrent())
                } else if mode == "selectionABA" {
                    host.model.focusChatSession("other")
                    host.model.focusChatSession("global")
                } else if mode == "root" {
                    host.router.unregisterPresentation(root)
                    host.presentationID = host.router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
                } else if mode == "route" {
                    await host.model.operatorSession.disconnect()
                } else if mode != "afterRefresh" {
                    let run = OpenClawNativeRunRef(session: host.session(), runID: "newer-inspection")
                    let task = Task { try await host.router.inspect(run).inspection }
                    inspecting = task
                    let receipt = try await host.waitForReceipt()
                    host.router.acknowledgeInspection(receipt, presentationID: root)
                    #expect(try await task.value.run == run)
                    #expect(!captured.isCurrent())
                    #expect(host.model.chatSessionKey == "global")
                    #expect(host.model.chatDeliveryAgentId == "main")
                }
                let requestID = host.model.openChatRequestID
                let binding = host.binding
                let receipt = host.receipt
                release.continuation.finish()
                if mode == "afterRefresh" {
                    try await AsyncTimeout.withTimeout(seconds: 2, onTimeout: { URLError(.timedOut) }) {
                        for await _ in forkReturned.stream {
                            break
                        }
                    }
                    // The CommandCenter producers await refresh before their final commit.
                    #expect(host.router.userNavigationDidChange(presentationID: root))
                    commitRelease.continuation.finish()
                    #expect(try await fork.value == false)
                } else if mode == "ownSync" {
                    #expect(try await fork.value)
                    #expect(host.model.chatSessionKey == "agent:main:forked")
                    #expect(host.model.openChatRequestID == requestID + 1)
                } else {
                    await #expect(throws: CancellationError.self) { _ = try await fork.value }
                    #expect(host.binding === binding)
                    #expect(host.receipt?.id == receipt?.id)
                    if mode == "warm" || mode == "hidden" {
                        #expect(try host.router.isInspectionPresented(#require(receipt)))
                    }
                    #expect(host.model.chatSessionKey == "global")
                    #expect(host.model.openChatRequestID == requestID)
                }
                if mode != "ownSync" {
                    #expect(host.model.chatSessionKey == "global")
                    #expect(host.model.openChatRequestID == requestID)
                }
                #expect(chat.input == "Retained draft")
                #expect(host.createdSessions == 1)
                #expect(host.sent.isEmpty)
            } catch {
                release.continuation.finish()
                commitRelease.continuation.finish()
                fork.cancel()
                inspecting?.cancel()
                _ = try? await fork.value
                _ = try? await inspecting?.value
                throw error
            }
        }
    }

    @Test func `presentation retirement clears an inspection before its chat registers`() async throws {
        try await self.withHost { host in
            host.registerPresentedChat = false
            let run = OpenClawNativeRunRef(session: host.session(), runID: "run-a")
            let inspection = Task { try await host.router.inspect(run).inspection }
            do {
                let receipt = try await host.waitForReceipt()
                let binding = try #require(host.binding)
                let presentationID = try #require(host.presentationID)
                host.router.unregisterPresentation(presentationID)
                #expect(host.binding == nil)
                #expect(host.receipt == nil)
                host.router.acknowledgeInspection(receipt, presentationID: presentationID)
                #expect(!host.router.isInspectionPresented(receipt))
                await #expect(throws: CancellationError.self) { _ = try await inspection.value }
                #expect(await binding.isCurrent())
            } catch {
                inspection.cancel()
                _ = try? await inspection.value
                throw error
            }
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `stale and duplicate presentation departures cannot retire a successor`() async throws {
        try await self.withHost { host in
            let oldID = try #require(host.presentationID)
            host.router.unregisterPresentation(oldID)
            var successorRetirements = 0
            let currentID = host.router
                .registerPresentation(onRetire: { _ in successorRetirements += 1 }) { _, _, _ in }
            host.presentationID = currentID
            host.router.unregisterPresentation(oldID)
            host.router.unregisterPresentation(oldID)
            #expect(successorRetirements == 0)
            host.router.unregisterPresentation(currentID)
            #expect(successorRetirements == 1)
            host.router.unregisterPresentation(currentID)
            #expect(successorRetirements == 1)
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `selection departure during inspection history cannot revive its presentation`() async throws {
        try await self.withHost { host in
            _ = try await host.prepare()
            let chat = try #require(host.chat)
            host.beforeInspectionHistory = {
                chat.switchSession(to: "global", agentID: "research")
                chat.switchSession(to: "global", agentID: "main")
            }
            await #expect(throws: CancellationError.self) {
                _ = try await host.router.inspect(.init(session: host.session(), runID: "run-a")).inspection
            }
            #expect(host.receipt == nil)
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `same-run receipts require their own appearance after selection retirement`() async throws {
        try await self.withHost { host in
            _ = try await host.prepare()
            let run = OpenClawNativeRunRef(session: host.session(), runID: "run-a")
            let first = Task { try await host.router.inspect(run).inspection }
            do {
                let oldReceipt = try await host.waitForReceipt()
                let chat = try #require(host.chat)
                chat.switchSession(to: "global", agentID: "research")
                chat.switchSession(to: "global", agentID: "main")
                #expect(host.receipt == nil)
                host.router.acknowledgeInspection(oldReceipt, presentationID: host.presentationID)
                #expect(!host.router.isInspectionPresented(oldReceipt))
                await #expect(throws: CancellationError.self) { _ = try await first.value }
                let second = Task { try await host.router.inspect(run).inspection }
                do {
                    let current = try await host.waitForReceipt()
                    #expect(current.id != oldReceipt.id)
                    host.router.acknowledgeInspection(oldReceipt, presentationID: host.presentationID)
                    #expect(!host.router.isInspectionPresented(current))
                    host.router.acknowledgeInspection(current, presentationID: host.presentationID)
                    #expect(host.router.isInspectionPresented(current))
                    #expect(try await second.value.run == run)
                } catch {
                    second.cancel()
                    _ = try? await second.value
                    throw error
                }
            } catch {
                first.cancel()
                _ = try? await first.value
                throw error
            }
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `proven account refusal releases the chat for an explicitly verified reopen`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            let binding = try #require(host.binding)
            chat.input = "preserved idle text"
            host.rejectMethod = "chat.send"
            do {
                _ = try await prepared.submit()
                Issue.record("The Gateway must reject this send before execution")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message == "chat.send: [INVALID_REQUEST] Selected profile changed")
            }
            #expect(host.rejectMethod == nil)
            #expect(host.sent.count == 1)
            #expect(await binding.isCurrent() == false)
            #expect(await binding.gateway.currentRoute() == binding.route)
            #expect(chat.pendingRunCount == 0)
            #expect(chat.messages.isEmpty)
            #expect(chat.input == "preserved idle text")
            #expect(chat.canPreserveIdleTextDraft)
            try host.hideChat()
            host.model.chatPresentation.sync(appModel: host.model)
            #expect(await host.router.open(.session(host.session())) == .opened)
            let fresh = try #require(host.binding)
            #expect(host.chat !== chat)
            #expect(host.chat?.input == "preserved idle text")
            #expect(fresh.profileObservationID != binding.profileObservationID)
            #expect(await fresh.isCurrent())
            #expect(host.sent.count == 1)
            let next = try await host.prepare()
            #expect(try await next.submit().runID == "run-2")
            #expect(host.sent.count == 2)
        }
    }

    @Test func `uncertain retained confirmation never reports a safe resend`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            host.rejectMethod = "chat.send"
            host.rejectionExecution = "may_have_executed"
            do {
                _ = try await prepared.submit()
                Issue.record("Handler entry must preserve delivery uncertainty")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message == "The selected account changed. "
                    + "Delivery is unconfirmed; check the chat before retrying.")
            }
            #expect(host.rejectMethod == nil)
            #expect(host.sent.count == 1)
            do {
                _ = try await prepared.submit()
                Issue.record("A retired confirmation cannot replay or claim non-dispatch")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message ==
                    "Reconnect to the selected account to check this operation. Do not send it again.")
            }
            #expect(host.sent.count == 1)
        }
    }

    @Test(arguments: ["idle-b", "same-target-aba"])
    func `automatic opening preserves newer navigation after an accepted send`(departure: String) async throws {
        try await self.withHost { host in
            let prepared = try await host.router.prepareSend(to: host.session(), message: "one accepted message")
            let entered = AsyncStream<Void>.makeStream()
            let release = AsyncStream<Void>.makeStream()
            host.deferredSendReply = {
                entered.continuation.yield(())
                for await _ in release.stream {
                    break
                }
            }
            let submit = Task {
                defer { entered.continuation.finish() }
                return try await prepared.send.submit()
            }
            do {
                var iterator = entered.stream.makeAsyncIterator()
                _ = try #require(await iterator.next())
                try #require(host.sent.count == 1)
                host.model.setSelectedAgentId("research")
                if departure == "same-target-aba" { host.model.setSelectedAgentId("main") }
                release.continuation.finish()
                let run = try await submit.value
                #expect(run == .init(session: host.session(), runID: "run-1"))

                let destination = host.session(departure == "idle-b" ? "research" : "main")
                try #require(await host.router.open(.session(destination)) == .opened)
                let chat = try #require(host.chat)
                try #require(chat.input.isEmpty && !chat.hasDraftToSend && chat.pendingRunCount == 0)
                let presentations = host.presentations
                let reads = host.nativeReads
                let owner = host.model.chatViewModelOwnerID
                let attachments = chat.attachments.map(\.id)
                #expect(try await host.router.openRun(run, continuing: prepared.presentationContinuationID) == .skipped)
                #expect(host.chat === chat)
                #expect(host.model.chatViewModelOwnerID == owner)
                #expect(host.model.chatDeliveryAgentId == destination.agentID)
                #expect(host.model.chatSessionKey == destination.sessionKey)
                #expect(chat.input.isEmpty && chat.replyTarget == nil && chat.attachments.map(\.id) == attachments)
                #expect(host.receipt == nil)
                #expect(host.presentations == presentations && host.nativeReads == reads)
                do {
                    _ = try await prepared.send.submit()
                    Issue.record("Retired replay must preserve the accepted send and refuse redispatch")
                } catch let error as OpenClawNativeActionError {
                    #expect(error.message ==
                        "Reconnect to the selected account to check this operation. Do not send it again.")
                }
                #expect(host.sent.count == 1)
                // A subsequent deliberate Open Run has fresh presentation authority.
                #expect(try await host.acknowledgingInspection { await host.router.open(.inspect(run)) } == .opened)
                #expect(host.binding?.session == run.session)
                #expect(host.sent.count == 1)
            } catch {
                release.continuation.finish()
                submit.cancel()
                _ = try? await submit.value
                entered.continuation.finish()
                throw error
            }
        }
    }

    @Test func `automatic send and inspection reuse only their current origin`() async throws {
        try await self.withHost { host in
            let first = try await host.router.prepareSend(to: host.session(), message: "accepted once")
            let sameOrigin = try await host.router.prepareSend(to: host.session(), message: "not submitted")
            #expect(first.presentationContinuationID == sameOrigin.presentationContinuationID)
            let run = try await first.send.submit()
            #expect(try await first.send.submit() == run)
            #expect(host.sent.count == 1)
            #expect(try await host.acknowledgingInspection {
                try await host.router.openRun(run, continuing: first.presentationContinuationID)
            } == .opened)
            let inspected = try await host.acknowledgingInspection { try await host.router.inspect(run) }
            #expect(inspected.inspection.run == run)
            #expect(inspected.presentationContinuationID == first.presentationContinuationID)
            #expect(try await host.acknowledgingInspection {
                try await host.router.openRun(run, continuing: inspected.presentationContinuationID)
            } == .opened)

            let newer = try await host.router.prepareSend(to: host.session("research"), message: "new origin")
            #expect(newer.presentationContinuationID != first.presentationContinuationID)
            #expect(try await host.router.openRun(run, continuing: inspected.presentationContinuationID) == .skipped)
            let newerRun = OpenClawNativeRunRef(session: host.session("research"), runID: "newer-run")
            #expect(try await host.acknowledgingInspection {
                try await host.router.openRun(newerRun, continuing: newer.presentationContinuationID)
            } == .opened)
            #expect(host.sent.count == 1)
        }
    }

    @Test(arguments: ["root-removed", "root-replaced", "account-aba", "config-aba", "route", "unknown-id"])
    func `automatic opening cannot renew a retired origin`(retirement: String) async throws {
        try await self.withHost { host in
            let prepared = try await host.router.prepareSend(to: host.session(), message: "not sent")
            let binding = try #require(host.binding)
            switch retirement {
            case "root-removed", "root-replaced":
                try host.router.unregisterPresentation(#require(host.presentationID))
                if retirement == "root-replaced" { host.registerPresentation() }
            case "account-aba":
                binding.observe(.verified(profileID: "other-fixture-profile"))
                binding.observe(.verified(profileID: binding.expectedProfileId))
            case "config-aba":
                let original = try #require(host.model.activeGatewayConnectConfig)
                host.model.activeGatewayConnectConfig = GatewayConnectConfig(
                    url: original.url, stableID: original.stableID, tls: original.tls,
                    token: "replacement-fixture-account", bootstrapToken: original.bootstrapToken,
                    password: original.password, nodeOptions: original.nodeOptions)
                host.model.activeGatewayConnectConfig = original
            case "route": await host.model.operatorSession.disconnect()
            default: break
            }
            let presentations = host.presentations
            let reads = host.nativeReads
            let id = retirement == "unknown-id" ? UUID() : prepared.presentationContinuationID
            #expect(try await host.router
                .openRun(.init(session: host.session(), runID: "run-a"), continuing: id) == .skipped)
            #expect(host.presentations == presentations && host.nativeReads == reads)
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: ["chat.history", "agents.list"])
    func `automatic opening revalidates its origin after history and binding reads`(method: String) async throws {
        try await self.withHost { host in
            let prepared = try await host.router.prepareSend(to: host.session(), message: "not sent")
            let presentations = host.presentations
            host.beforeResponse = { received in
                guard received == method else { return }
                host.beforeResponse = nil
                // The awaited real fixture response has not been sent yet.
                host.model.setSelectedAgentId("research")
                host.model.setSelectedAgentId("main")
            }
            let opening = Task {
                try await host.router.openRun(
                    .init(session: host.session(), runID: "run-a"), continuing: prepared.presentationContinuationID)
            }
            do {
                #expect(try await opening.value == .skipped)
                #expect(host.beforeResponse == nil)
                #expect(host.presentations == presentations && host.receipt == nil)
                #expect(host.model.chatDeliveryAgentId == "main")
                #expect(host.sent.isEmpty)
            } catch {
                opening.cancel()
                _ = try? await opening.value
                throw error
            }
        }
    }

    @Test func `automatic opening preserves actual account read errors`() async throws {
        try await self.withHost { host in
            let prepared = try await host.router.prepareSend(to: host.session(), message: "not sent")
            host.rejectMethod = "chat.history"
            await #expect(throws: GatewayResponseError.self) {
                _ = try await host.router.openRun(
                    .init(session: host.session(), runID: "run-a"), continuing: prepared.presentationContinuationID)
            }
            #expect(host.rejectMethod == nil)
            #expect(host.sent.isEmpty && host.receipt == nil)
        }
    }

    @Test func `accepted acknowledgement survives target retirement without a second send`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            host.beforeSendReply = {
                chat.switchSession(to: "global", agentID: "research")
                chat.switchSession(to: "global", agentID: "main")
            }
            let run = try await prepared.submit()
            #expect(run.runID == "run-1")
            #expect(run.session == host.session())
            #expect(host.sent.count == 1)
            do {
                _ = try await prepared.submit()
                Issue.record("A retired confirmation cannot claim that the accepted send never happened")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message ==
                    "Reconnect to the selected account to check this operation. Do not send it again.")
            }
            #expect(host.sent.count == 1)
        }
    }

    @Test(arguments: [false, true], ["disconnect", "account refusal"])
    func `retained confirmations preserve no resend after gateway verification fails`(
        uncertain: Bool, retirement: String) async throws
    {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let binding = try #require(host.binding)
            if uncertain {
                host.rejectMethod = "chat.send"
                host.rejectionExecution = "may_have_executed"
                do {
                    _ = try await prepared.submit()
                    Issue.record("The original send must retain delivery uncertainty")
                } catch let error as OpenClawNativeActionError {
                    #expect(error.message == "The selected account changed. "
                        + "Delivery is unconfirmed; check the chat before retrying.")
                }
            } else {
                #expect(try await prepared.submit() == .init(session: host.session(), runID: "run-1"))
            }
            #expect(host.sent.count == 1)
            if retirement == "disconnect" {
                await host.model.operatorSession.disconnect()
                #expect(await binding.gateway.currentRoute() != binding.route)
            } else {
                host.rejectMethod = "users.self"
                host.rejectionExecution = "not_started"
                #expect(await binding.gateway.currentRoute() == binding.route)
            }
            do {
                _ = try await prepared.submit()
                Issue.record("Failed verification cannot expose a retained receipt or imply safe replay")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message ==
                    "Reconnect to the selected account to check this operation. Do not send it again.")
            }
            #expect(host.rejectMethod == nil)
            #expect(await binding.isCurrent() == false)
            #expect(host.sent.count == 1)
        }
    }

    @Test func `disconnected initial confirmation keeps its admission error without sending`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            await host.model.operatorSession.disconnect()
            await #expect(throws: CancellationError.self) { _ = try await prepared.submit() }
            #expect(host.sent.isEmpty)
        }
    }
}
