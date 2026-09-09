import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol

@MainActor @Observable
final class WatchDirectConversations {
    private weak var gateway: WatchGatewayController?
    @ObservationIgnored private let makeSession: @MainActor (URL, String) throws -> GatewayOperatorHTTPSession
    private var session: GatewayOperatorHTTPSession?
    private var connectionConfiguration: WatchGatewayConfiguration?
    private var connectionTask: Task<Void, Never>?
    private var pendingSessionCleanup: Task<Void, Never>?
    private var generation = UUID()
    private var selection = UUID()
    private var visible = false
    private var refreshTask: Task<Void, Never>?
    private var refreshAgain = false
    private var historyGeneration = UUID()
    private var activeSendID: UUID?
    private var activeRunID: String?
    private(set) var connected = false
    private(set) var busy = false
    private(set) var upgrading = false
    private(set) var scopes = Set<String>()
    private(set) var agents: [AgentSummary] = []
    private(set) var selectedAgentID: String?
    private(set) var sessions: [WatchDirectSession] = []
    private(set) var route: WatchDirectRoute?
    private(set) var messages: [WatchDirectMessage] = []
    private(set) var approvals: [WatchDirectApproval] = []
    private(set) var approvalsTruncated = false
    private(set) var historyTruncated = false
    private(set) var status = String(localized: "Not connected")
    private(set) var deliveryStatus: String?

    init(
        gateway: WatchGatewayController,
        makeSession: @escaping @MainActor (URL, String) throws -> GatewayOperatorHTTPSession = {
            try GatewayOperatorHTTPSession(endpoint: $0, gatewayID: $1)
        })
    {
        self.gateway = gateway
        self.makeSession = makeSession
    }

    var canWrite: Bool {
        self.isCurrent(self.generation) && self.connected
            && self.scopes.contains("operator.write") && !self.busy && !self.upgrading
    }

    var canApprove: Bool {
        self.isCurrent(self.generation) && self.connected && self.scopes.contains("operator.approvals") && !self
            .upgrading
    }

    var canAbort: Bool {
        self.isCurrent(self.generation) && self.connected
            && self.scopes.contains("operator.write") && !self.upgrading && self.activeRunID != nil
    }

    private var available: Bool {
        self.visible && self.gateway?.isEnabled == true && self.gateway?.isForeground == true
    }

    private func owns(_ generation: UUID, selection: UUID? = nil) -> Bool {
        self.generation == generation && (selection == nil || self.selection == selection)
    }

    private func isCurrent(_ generation: UUID, selection: UUID? = nil) -> Bool {
        self.owns(generation, selection: selection) && self.available && !Task.isCancelled
            && self.connectionConfiguration.map { self.gateway?.isInstalled($0) == true } == true
    }

    func appear() {
        self.visible = true
        self.resume()
    }

    func disappear() {
        self.visible = false
        self.suspend()
    }

    func resume() {
        guard self.available, self.connectionTask == nil, self.session == nil else { return }
        self.retire(clear: false)
        let cleanup = self.takeSessionCleanup()
        let generation = self.generation
        self.connectionTask = Task { [weak self] in
            await cleanup?.value
            guard !Task.isCancelled else { return }
            await self?.connect(generation: generation)
        }
    }

    func suspend() {
        self.retire(clear: false)
    }

    func disconnect(clear: Bool) async {
        self.retire(clear: clear)
        let cleanup = self.takeSessionCleanup()
        await cleanup?.value
    }

    private func retireSession() {
        guard let session = self.session else { return }
        self.session = nil
        self.pendingSessionCleanup = Task { await session.disconnect() }
    }

    private func takeSessionCleanup() -> Task<Void, Never>? {
        // Transfer before awaiting: later setup must not inherit an obsolete
        // action's claimed cleanup, but repeated suspension must not lose it.
        defer { self.pendingSessionCleanup = nil }
        return self.pendingSessionCleanup
    }

    private func retire(clear: Bool) {
        // Retirement owns the outcome because old task catches lose authority here.
        if !clear, self.busy {
            self.deliveryStatus = String(
                localized: "Delivery uncertain. Check the original conversation before sending again.")
        }
        if !clear, self.upgrading { self.gateway?.requireSetupRecovery() }
        self.generation = UUID()
        self.selection = UUID()
        self.connectionTask?.cancel()
        self.connectionTask = nil
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.refreshAgain = false
        self.retireSession()
        self.connectionConfiguration = nil
        self.connected = false
        self.scopes = []
        self.busy = false
        self.upgrading = false
        self.activeSendID = nil
        for index in self.approvals.indices {
            self.approvals[index].needsReadback = true
        }
        if clear {
            self.route = nil
            self.selectedAgentID = nil
            self.sessions = []
            self.agents = []
            self.messages = []
            self.approvals = []
            self.deliveryStatus = nil
            self.activeRunID = nil
        }
    }

    private func connect(generation: UUID) async {
        guard self.owns(generation), self.available, self.session == nil, let gateway else { return }
        defer {
            if self.generation == generation { self.connectionTask = nil }
        }
        guard let configuration = gateway.configuration,
              gateway.isInstalled(configuration),
              !gateway.setupIncomplete, !gateway.recoveryRequired,
              let endpoint = WatchGatewayConfiguration.httpBaseURL(for: configuration.link)
        else {
            self.status = String(localized: "Complete Watch setup first.")
            return
        }
        self.connectionConfiguration = configuration
        self.status = String(localized: "Connecting directly...")
        do {
            let session = try self.makeSession(endpoint, configuration.gatewayID)
            self.session = session
            let scopes = Set(gateway.storedOperatorScopes()).intersection(GatewayOperatorHTTPSession.allowedScopes)
                .sorted()
            let options = GatewayConnectOptions(
                role: "operator",
                scopes: scopes,
                scopesAreExplicit: true,
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-watchos",
                clientMode: "node",
                clientDisplayName: "OpenClaw Watch",
                deviceIdentityProfile: .primary,
                deviceAuthGatewayID: configuration.gatewayID)
            _ = try await session.connect(
                options: options,
                consumeHello: { [weak self] hello, isCurrent in
                    guard let self else { throw CancellationError() }
                    try await self.acceptHello(
                        hello,
                        configuration: configuration,
                        generation: generation,
                        isCurrent: isCurrent)
                },
                consumeEvent: { [weak self] event, isCurrent in
                    guard let self else { throw CancellationError() }
                    try await self.event(event, generation: generation, isCurrent: isCurrent)
                },
                onClosed: { [weak self] error in
                    await self?.closed(error, generation: generation)
                })
            guard self.isCurrent(generation) else { throw CancellationError() }
            self.connected = true
            self.status = String(localized: "Connected directly")
            _ = try await self.rpc("agents.list", params: [String: String](), as: AgentsListResult.self) { value, _ in
                self.agents = Array(value.agents.prefix(100))
                if !self.agents.contains(where: { $0.id.utf8.elementsEqual((self.selectedAgentID ?? "").utf8) }) {
                    self.selectedAgentID = self.agents.first?.id
                    self.route = nil
                }
            }
            guard self.isCurrent(generation) else { throw CancellationError() }
            try await self.loadSessions()
            guard self.isCurrent(generation) else { throw CancellationError() }
            if let route = self.route { try await self.restore(route) }
        } catch {
            guard self.generation == generation else { return }
            self.closed(error, generation: generation)
            let cleanup = self.takeSessionCleanup()
            await cleanup?.value
        }
    }

    private func acceptHello(
        _ hello: HelloOk,
        configuration: WatchGatewayConfiguration,
        generation: UUID,
        isCurrent: @Sendable () -> Bool) throws
    {
        guard self.isCurrent(generation), isCurrent(), let gateway else { throw CancellationError() }
        guard gateway.isInstalled(configuration) else { throw CancellationError() }
        self.scopes = Set(hello.auth["scopes"]?.arrayValue?.compactMap(\.stringValue) ?? [])
    }

    private func closed(_ error: any Error, generation: UUID) {
        guard self.generation == generation else { return }
        self.connected = false
        self.retireSession()
        self.status = error.localizedDescription
        for index in self.approvals.indices {
            self.approvals[index].needsReadback = true
        }
        if self.upgrading { self.gateway?.requireSetupRecovery() }
        if case GatewayOperatorHTTPError.pairingRequired = error { self.gateway?.requireSetupRecovery() }
    }

    func refresh() async {
        guard self.available else { return }
        if let connectionTask {
            await connectionTask.value
            return
        }
        if !self.connected {
            self.resume()
            let connectionTask = self.connectionTask
            await connectionTask?.value
            return
        }
        let generation = self.generation
        let selection = self.selection
        let route = self.route
        do {
            try await self.loadSessions()
            guard self.isCurrent(generation, selection: selection) else { return }
            if let route { try await self.restore(route) }
        } catch {
            if self.owns(generation, selection: selection) { self.status = error.localizedDescription }
        }
    }

    func selectAgent(_ id: String) async {
        guard self.isCurrent(self.generation), !self.busy, !self.upgrading,
              self.agents.contains(where: { $0.id.utf8.elementsEqual(id.utf8) })
        else { return }
        let generation = self.generation
        let selection = await self.leaveSession()
        guard self.isCurrent(generation, selection: selection),
              self.agents.contains(where: { $0.id.utf8.elementsEqual(id.utf8) })
        else { return }
        self.selectedAgentID = id
        do { try await self.loadSessions() } catch {
            if self.owns(generation, selection: selection) { self.status = error.localizedDescription }
        }
    }

    private func loadSessions() async throws {
        let generation = self.generation
        let selection = self.selection
        guard self.isCurrent(generation), let agentID = self.selectedAgentID else { return }
        _ = try await self.rpc(
            "sessions.list",
            params: SessionsListParams(limit: 50, includederivedtitles: true, agentid: agentID),
            as: WatchDirectSessionList.self)
        { value, _ in
            guard self.isCurrent(generation, selection: selection),
                  self.selectedAgentID?.utf8.elementsEqual(agentID.utf8) == true else { return }
            self.sessions = Array(value.sessions.prefix(50))
        }
    }

    func selectSession(_ session: WatchDirectSession) async {
        guard self.isCurrent(self.generation), !self.busy, !self.upgrading,
              let gateway, let configuration = gateway.configuration,
              let agentID = self.selectedAgentID,
              self.sessions.contains(where: { $0.key.utf8.elementsEqual(session.key.utf8) })
        else { return }
        let generation = self.generation
        let selection = await self.leaveSession()
        guard self.isCurrent(generation, selection: selection), gateway.isInstalled(configuration),
              self.selectedAgentID?.utf8.elementsEqual(agentID.utf8) == true,
              self.sessions.contains(where: { $0.key.utf8.elementsEqual(session.key.utf8) })
        else { return }
        let route = WatchDirectRoute(
            gatewayID: configuration.gatewayID,
            setupSentAtMs: configuration.setupSentAtMs,
            agentID: agentID,
            sessionKey: session.key)
        self.route = route
        do { try await self.restore(route) } catch {
            if self.owns(generation, selection: selection) { self.status = error.localizedDescription }
        }
    }

    private func leaveSession() async -> UUID {
        let previous = self.route
        let selection = UUID()
        self.selection = selection
        // Let submitted reads finish under their old selection. Canceling an
        // admitted RPC would retire the connection needed by the new selection.
        self.refreshTask = nil
        self.refreshAgain = false
        self.activeSendID = nil
        self.route = nil
        self.messages = []
        self.approvals = []
        self.activeRunID = nil
        self.historyTruncated = false
        self.approvalsTruncated = false
        if let previous, self.connected {
            _ = try? await self.rpc(
                "sessions.messages.unsubscribe",
                params: SessionsMessagesUnsubscribeParams(key: previous.sessionKey, agentid: previous.agentID),
                as: OpenClawProtocol.AnyCodable.self) { _, _ in }
        }
        return selection
    }

    private func restore(_ route: WatchDirectRoute) async throws {
        let generation = self.generation
        let selection = self.selection
        guard self.isCurrent(generation), self.route == route else { throw CancellationError() }
        for index in self.approvals.indices {
            self.approvals[index].needsReadback = true
        }
        _ = try await self.rpc(
            "sessions.messages.subscribe",
            params: SessionsMessagesSubscribeParams(
                key: route.sessionKey, agentid: route.agentID, includeapprovals: self.canApprove),
            as: WatchDirectSubscription.self)
        { value, _ in
            guard self.isCurrent(generation, selection: selection), self.route == route else { return }
            guard value.subscribed, value.key.utf8.elementsEqual(route.sessionKey.utf8) else {
                throw GatewayOperatorHTTPError.invalidContract
            }
            if let replay = value.approvalReplay {
                guard replay.sessionkey.utf8.elementsEqual(route.sessionKey.utf8) else {
                    throw GatewayOperatorHTTPError.invalidContract
                }
                self.approvalsTruncated = replay.truncated
                for approval in replay.approvals {
                    self.merge(.pending(approval))
                }
            }
        }
        guard self.isCurrent(generation, selection: selection), self.route == route else { return }
        try await self.history(route)
        guard self.isCurrent(generation, selection: selection), self.route == route else { return }
        for approval in self.approvals where approval.needsReadback {
            guard self.isCurrent(generation, selection: selection), self.route == route else { return }
            try await self.readApproval(approval.rawID, route: route)
        }
    }

    private func history(_ route: WatchDirectRoute) async throws {
        let generation = self.generation
        let selection = self.selection
        guard self.isCurrent(generation), self.route == route else { throw CancellationError() }
        let historyGeneration = UUID()
        self.historyGeneration = historyGeneration
        _ = try await self.rpc(
            "chat.history",
            params: ChatHistoryParams(
                sessionkey: route.sessionKey,
                agentid: route.agentID,
                limit: 100,
                maxbytes: 256 * 1024,
                maxchars: 20000),
            as: WatchDirectHistory.self)
        { value, _ in
            guard self.isCurrent(generation, selection: selection), self.route == route,
                  self.historyGeneration == historyGeneration
            else { return }
            self.messages = value.messages.suffix(100).enumerated().compactMap {
                WatchDirectMessage($0.element, fallbackID: "history-\($0.offset)")
            }
            self.historyTruncated = value.hasMore == true || value.truncated == true || value.messages.count > 100
        }
    }

    func createSession() async {
        guard self.canWrite, let agentID = self.selectedAgentID else { return }
        let generation = self.generation
        let selection = self.selection
        self.busy = true
        self.deliveryStatus = String(localized: "Creating conversation...")
        defer {
            if self.owns(generation, selection: selection) { self.busy = false }
        }
        do {
            let created = try await self.rpc(
                "sessions.create",
                params: SessionsCreateParams(idempotencykey: UUID().uuidString, agentid: agentID),
                as: SessionsCreateResult.self)
            { value, _ in
                guard self.isCurrent(generation, selection: selection) else { throw CancellationError() }
                guard value.ok, !value.key.isEmpty else { throw GatewayOperatorHTTPError.invalidContract }
                self.deliveryStatus = String(localized: "Conversation created")
            }
            guard self.isCurrent(generation, selection: selection) else { return }
            try await self.loadSessions()
            guard self.isCurrent(generation, selection: selection) else { return }
            self.busy = false
            if let entry = self.sessions.first(where: { $0.key.utf8.elementsEqual(created.key.utf8) }) {
                await self.selectSession(entry)
            }
        } catch {
            if self.owns(generation, selection: selection) { self.deliveryStatus = error.localizedDescription }
        }
    }

    func send(_ text: String, route: WatchDirectRoute) async {
        guard self.canWrite, self.route == route, !text.isEmpty else {
            self.deliveryStatus = String(localized: "Conversation changed. Message was not sent.")
            return
        }
        let idempotencyKey = UUID().uuidString
        let sendID = UUID()
        let generation = self.generation
        let selection = self.selection
        self.activeSendID = sendID
        self.busy = true
        self.deliveryStatus = String(localized: "Sending directly...")
        defer {
            if self.owns(generation, selection: selection), self.activeSendID == sendID {
                self.busy = false
                self.activeSendID = nil
            }
        }
        do {
            _ = try await self.rpc(
                "chat.send",
                params: ChatSendParams(
                    sessionkey: route.sessionKey,
                    agentid: route.agentID,
                    message: text,
                    idempotencykey: idempotencyKey),
                as: OpenClawProtocol.AnyCodable.self)
            { value, _ in
                guard self.isCurrent(generation, selection: selection), self.activeSendID == sendID,
                      self.route == route else { return }
                self.activeRunID = value.dictionaryValue?["runId"]?.stringValue
                self.deliveryStatus = String(localized: "Accepted by Gateway")
            }
            guard self.isCurrent(generation, selection: selection), self.activeSendID == sendID else { return }
            let runID = self.activeRunID
            self.busy = false
            try await self.history(route)
            guard self.isCurrent(generation, selection: selection), self.activeSendID == sendID else { return }
            if let runID {
                _ = try await self.rpc(
                    "agent.wait",
                    params: AgentWaitParams(runid: runID, timeoutms: 20000),
                    as: OpenClawProtocol.AnyCodable.self)
                { value, _ in
                    guard self.isCurrent(generation, selection: selection), self.activeSendID == sendID,
                          self.route == route else { return }
                    if value.dictionaryValue?["status"]?.stringValue != "timeout",
                       self.activeRunID?.utf8.elementsEqual(runID.utf8) == true
                    {
                        self.activeRunID = nil
                    }
                }
                guard self.isCurrent(generation, selection: selection), self.activeSendID == sendID else { return }
                try await self.history(route)
            }
        } catch {
            // No reconnect, companion fallback, or application-level resend is admitted here.
            if self.owns(generation, selection: selection), self.activeSendID == sendID {
                self.deliveryStatus = error.localizedDescription
            }
        }
    }

    func abort() async {
        guard self.canAbort, let route, let runID = self.activeRunID else { return }
        let generation = self.generation
        let selection = self.selection
        do {
            _ = try await self.rpc(
                "chat.abort",
                params: ChatAbortParams(
                    sessionkey: route.sessionKey, agentid: route.agentID, runid: runID),
                as: OpenClawProtocol.AnyCodable.self)
            { _, _ in
                guard self.isCurrent(generation, selection: selection) else { return }
                self.deliveryStatus = String(localized: "Stop requested")
            }
            guard self.isCurrent(generation, selection: selection) else { return }
            try await self.history(route)
        } catch {
            if self.owns(generation, selection: selection) { self.deliveryStatus = error.localizedDescription }
        }
    }

    func requestUpgrade() async {
        guard self.isCurrent(self.generation), self.connected, !self.upgrading,
              let gateway, let configuration = gateway.configuration else { return }
        let generation = self.generation
        self.upgrading = true
        defer {
            if self.owns(generation) { self.upgrading = false }
        }
        let requested = self.scopes.union(["operator.write", "operator.approvals"]).sorted()
        do {
            let registration = try await self.rpc(
                "device.scopes.requestUpgrade",
                params: ScopeUpgradeRequest(scopes: requested),
                as: ScopeUpgradeRegistration.self)
            { _, _ in self.status = String(localized: "Waiting for Gateway administrator approval...") }
            guard self.isCurrent(generation) else { return }
            _ = try await self.rpc(
                "device.scopes.waitUpgrade",
                params: ScopeUpgradeWait(requestid: registration.requestid),
                as: ScopeUpgradeResult.self,
                timeoutMs: 120_000)
            { result, isCurrent in
                switch result {
                case let .approved(value):
                    guard value.requestid.utf8.elementsEqual(registration.requestid.utf8),
                          Set(value.scopes) == Set(requested)
                    else { throw GatewayOperatorHTTPError.invalidContract }
                    try await gateway.installOperatorGrant(
                        token: value.devicetoken,
                        scopes: value.scopes,
                        configuration: configuration,
                        isCurrent: isCurrent)
                    guard self.isCurrent(generation), isCurrent() else { throw CancellationError() }
                    self.status = String(localized: "Access upgraded")
                case .rejected:
                    self.status = String(localized: "Access request denied")
                case .expired:
                    self.status = String(localized: "Access request expired")
                }
            }
            guard self.isCurrent(generation) else { return }
            self.upgrading = false
            self.retire(clear: false)
            let cleanup = self.takeSessionCleanup()
            let reconnectGeneration = self.generation
            await cleanup?.value
            guard self.owns(reconnectGeneration), self.available, gateway.isInstalled(configuration) else { return }
            self.resume()
            let connectionTask = self.connectionTask
            await connectionTask?.value
        } catch {
            guard self.owns(generation) else { return }
            if case GatewayOperatorHTTPError.resultUnknown = error { gateway.requireSetupRecovery() }
            self.status = error.localizedDescription
        }
    }

    func resolve(_ approval: WatchDirectApproval, decision: ApprovalDecision) async {
        guard self.canApprove, let route,
              let index = self.approvals.firstIndex(where: { $0.id == approval.id }),
              self.approvals[index].decisions.contains(decision)
        else { return }
        let generation = self.generation
        let selection = self.selection
        self.approvals[index].resolving = true
        do {
            _ = try await self.rpc(
                "approval.resolve",
                params: ApprovalResolveParams(id: approval.rawID, kind: approval.kind, decision: decision),
                as: ApprovalResolveResult.self)
            { result, _ in
                guard self.isCurrent(generation, selection: selection), self.route == route else { return }
                let snapshot = try Self.decode(ApprovalSnapshot.self, value: Self.value(result.approval))
                guard WatchDirectApproval(snapshot: snapshot).id == approval.id else {
                    throw GatewayOperatorHTTPError.invalidContract
                }
                // applied:false may be an already-terminal decision from another reviewer.
                self.merge(snapshot)
            }
            guard self.isCurrent(generation, selection: selection) else { return }
            try await self.readApproval(approval.rawID, route: route)
        } catch {
            guard self.owns(generation, selection: selection) else { return }
            if let index = self.approvals.firstIndex(where: { $0.id == approval.id }) {
                self.approvals[index].resolving = false
                self.approvals[index].needsReadback = true
            }
            self.status = error.localizedDescription
            if self.isCurrent(generation), self.connected {
                try? await self.readApproval(approval.rawID, route: route)
            }
        }
    }

    private func readApproval(_ id: String, route: WatchDirectRoute) async throws {
        guard self.canApprove, self.route == route else { return }
        let generation = self.generation
        let selection = self.selection
        _ = try await self.rpc("approval.get", params: ApprovalGetParams(id: id), as: ApprovalGetResult.self)
            { value, _ in
                guard self.isCurrent(generation, selection: selection), self.route == route else { return }
                guard WatchDirectApproval(snapshot: value.approval).rawID.utf8.elementsEqual(id.utf8) else {
                    throw GatewayOperatorHTTPError.invalidContract
                }
                self.merge(value.approval)
            }
    }

    private func merge(_ snapshot: ApprovalSnapshot) {
        let record = WatchDirectApproval(snapshot: snapshot)
        if let index = self.approvals.firstIndex(where: { $0.id == record.id }) {
            if case .pending = snapshot {
                guard case .pending = self.approvals[index].snapshot else { return }
            }
            self.approvals[index] = record
        } else if self.approvals.count < 100 {
            self.approvals.append(record)
        } else {
            self.approvalsTruncated = true
        }
    }

    private func event(_ event: EventFrame, generation: UUID, isCurrent: @Sendable () -> Bool) throws {
        guard self.isCurrent(generation), isCurrent() else { throw CancellationError() }
        let selection = self.selection
        guard let route, let payload = event.payload else { return }
        if event.event == "session.approval", self.canApprove {
            let value = try Self.decode(SessionApprovalEvent.self, value: payload)
            switch value {
            case let .pending(value):
                guard value.sessionkey.utf8.elementsEqual(route.sessionKey.utf8) else { return }
                self.merge(.pending(value.approval))
            case let .terminal(value):
                guard value.sessionkey.utf8.elementsEqual(route.sessionKey.utf8) else { return }
                let snapshot = try Self.decode(ApprovalSnapshot.self, value: Self.value(value.approval))
                self.merge(snapshot)
                let id = WatchDirectApproval(snapshot: snapshot).rawID
                if let index = self.approvals.firstIndex(where: { $0.id == WatchOpaqueUTF8Key(id) }) {
                    self.approvals[index].needsReadback = true
                }
                Task {
                    guard self.isCurrent(generation, selection: selection) else { return }
                    try? await self.readApproval(id, route: route)
                }
            }
        } else if event.event == "session.message" || event.event == "chat" {
            guard payload.dictionaryValue?["sessionKey"]?.stringValue?.utf8.elementsEqual(route.sessionKey.utf8) == true
            else { return }
            if self.refreshTask == nil {
                self.refreshTask = Task {
                    defer {
                        if self.owns(generation, selection: selection) { self.refreshTask = nil }
                    }
                    repeat {
                        guard self.isCurrent(generation, selection: selection), self.route == route else { return }
                        self.refreshAgain = false
                        do { try await self.history(route) } catch {
                            if self.owns(generation, selection: selection) { self.status = error.localizedDescription }
                        }
                    } while self.refreshAgain && self.isCurrent(generation, selection: selection)
                        && self.route == route && self.connected
                }
            } else {
                self.refreshAgain = true
            }
        }
    }

    private func rpc<T: Decodable & Sendable>(
        _ method: String,
        params: some Encodable & Sendable,
        as type: T.Type,
        timeoutMs: Int = 30000,
        consume: @escaping @MainActor @Sendable (T, @Sendable () -> Bool) async throws -> Void) async throws -> T
    {
        guard self.isCurrent(self.generation), let session else { throw GatewayOperatorHTTPError.disconnected }
        let generation = self.generation
        let response = try await session.request(
            method: method, params: Self.value(params), timeoutMs: timeoutMs)
        { [weak self] response, isCurrent in
            guard response.ok else { return }
            guard let payload = response.payload else { throw GatewayOperatorHTTPError.invalidContract }
            let value = try Self.decode(type, value: payload)
            guard let self else { throw CancellationError() }
            try await self.commit(value, generation: generation, isCurrent: isCurrent, consume: consume)
        }
        guard self.isCurrent(generation), let payload = response.payload else { throw CancellationError() }
        return try Self.decode(type, value: payload)
    }

    private func commit<T: Sendable>(
        _ value: T,
        generation: UUID,
        isCurrent: @Sendable () -> Bool,
        consume: @escaping @MainActor @Sendable (T, @Sendable () -> Bool) async throws -> Void) async throws
    {
        guard self.isCurrent(generation), isCurrent() else { throw CancellationError() }
        try await consume(value, isCurrent)
        guard self.isCurrent(generation), isCurrent() else { throw CancellationError() }
    }

    private nonisolated static func value(_ value: some Encodable) throws -> OpenClawProtocol.AnyCodable {
        try JSONDecoder().decode(OpenClawProtocol.AnyCodable.self, from: JSONEncoder().encode(value))
    }

    private nonisolated static func decode<T: Decodable>(
        _ type: T.Type, value: OpenClawProtocol.AnyCodable) throws -> T
    {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }
}
