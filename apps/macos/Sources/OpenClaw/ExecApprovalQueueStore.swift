import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

struct ExecApprovalQueueItem: Decodable, Identifiable {
    enum ApprovalKind: String, Hashable {
        case exec
        case plugin
        case systemAgent = "system-agent"

        var listMethod: String {
            switch self {
            case .exec: "exec.approval.list"
            case .plugin: "plugin.approval.list"
            case .systemAgent: "openclaw.approval.list"
            }
        }
    }

    // The durable registry shares IDs across approval kinds.
    let id: String
    let sessionKey: String?
    let agentID: String?
    let createdAtMs: Int
    let expiresAtMs: Int
    private(set) var kind: ApprovalKind = .exec
    private(set) var preview: String
    private(set) var allowedDecisions: [ExecApprovalDecision]
    private let publicationID = UUID()
    fileprivate var serverLease: GatewayConnection.ServerLease?

    var idKey: Data {
        Data(self.id.utf8)
    }

    func attentionRequest(ownerID: String) -> OpenClawChatAttentionRequest {
        .init(
            id: self.id,
            kind: .approval,
            sessionKey: self.sessionKey,
            agentID: self.agentID,
            createdAtMs: Double(self.createdAtMs),
            expiresAtMs: Double(self.expiresAtMs),
            preview: self.preview,
            ownerID: ownerID)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let request = try container.nestedContainer(keyedBy: RequestCodingKeys.self, forKey: .request)
        self.id = try container.decode(String.self, forKey: .id)
        self.createdAtMs = try container.decode(Int.self, forKey: .createdAtMs)
        self.expiresAtMs = try container.decode(Int.self, forKey: .expiresAtMs)
        self.sessionKey = try request.decodeIfPresent(String.self, forKey: .sessionKey)
        self.agentID = try request.decodeIfPresent(String.self, forKey: .agentId)
        let command = try request.decodeIfPresent(String.self, forKey: .command)
        let title = try request.decodeIfPresent(String.self, forKey: .title)
        let description = try request.decodeIfPresent(String.self, forKey: .description)
        guard command != nil || title != nil else {
            throw DecodingError.keyNotFound(RequestCodingKeys.command, .init(
                codingPath: request.codingPath, debugDescription: "Approval request has no display text"))
        }
        self.preview = Self.safePreview([command, title, description].compactMap(\.self))
        let decisions = (try? request.decode([String].self, forKey: .allowedDecisions)) ?? []
        self.allowedDecisions = request.contains(.allowedDecisions)
            ? decisions.compactMap(ExecApprovalDecision.init(rawValue:)).filter { $0 != .allowAlways }
            : [.allowOnce, .deny]
    }

    fileprivate func owned(by lease: GatewayConnection.ServerLease, kind: ApprovalKind) -> Self {
        var owned = self
        owned.kind = kind
        owned.serverLease = lease
        // Plugin approval policy belongs to its own approval surface, never the exec menu.
        if kind == .plugin { owned.allowedDecisions = [] }
        return owned
    }

    fileprivate func presenting(_ snapshot: ApprovalSnapshot) -> Self? {
        guard case let .pending(pending) = snapshot, Data(pending.id.utf8) == self.idKey else { return nil }
        let text: [String]
        let decisions: [String]
        switch (self.kind, pending.presentation) {
        case let (.exec, .exec(presentation)):
            text = [presentation.commandtext]
            decisions = presentation.alloweddecisions.map(\.rawValue)
        case let (.plugin, .plugin(presentation)):
            text = [presentation.title, presentation.description] + [presentation.detail].compactMap(\.self)
            decisions = []
        case let (.systemAgent, .systemAgent(presentation)):
            text = [presentation.title, presentation.description]
            decisions = presentation.alloweddecisions.compactMap { $0.value as? String }
        default:
            return nil
        }
        var result = self
        // Presentation is a safe projection; source routing and age stay with the original request.
        result.preview = Self.safePreview(text)
        result.allowedDecisions = self.allowedDecisions.filter { decisions.contains($0.rawValue) }
        return result
    }

    fileprivate func hasSameSource(as other: Self) -> Bool {
        self.idKey == other.idKey && self.kind == other.kind && self.serverLease == other.serverLease &&
            self.publicationID == other.publicationID
    }

    private static func safePreview(_ parts: [String]) -> String {
        parts.filter { !$0.isEmpty }.map(ExecApprovalCommandDisplaySanitizer.sanitize).joined(separator: "\n\n")
    }

    private enum CodingKeys: String, CodingKey {
        case id, request, createdAtMs, expiresAtMs
    }

    private enum RequestCodingKeys: String, CodingKey {
        case command, title, description, sessionKey, agentId, allowedDecisions
    }
}

@MainActor
@Observable
final class ExecApprovalQueueStore {
    static var shared: ExecApprovalQueueStore {
        GatewayConnection.shared.approvalQueue
    }

    private(set) var requests: [ExecApprovalQueueItem] = []
    private var attentionOwnerID = UUID()

    var attentionRequests: [OpenClawChatAttentionRequest] {
        self.requests.map { $0.attentionRequest(ownerID: self.attentionOwnerID.uuidString) }
    }

    @ObservationIgnored private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.queue")
    @ObservationIgnored private let gateway: GatewayConnection
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var admittedLease: GatewayConnection.ServerLease?
    @ObservationIgnored private var pendingRefresh: (
        lease: GatewayConnection.ServerLease,
        task: Task<Void, Never>)?
    @ObservationIgnored private var expiryTasks: [Data: Task<Void, Never>] = [:]
    @ObservationIgnored private var refreshGeneration: UInt64 = 0

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    isolated deinit {
        self.stop()
    }

    func start() {
        guard self.eventTask == nil else { return }
        self.eventTask = Task { [weak self, weak gateway] in
            guard let stream = await gateway?.subscribe(bufferingNewest: 200) else { return }
            for await delivery in stream {
                guard !Task.isCancelled, let self else { return }
                self.handle(delivery: delivery)
            }
        }
    }

    func stop() {
        self.eventTask?.cancel()
        self.eventTask = nil
        self.pendingRefresh?.task.cancel()
        self.pendingRefresh = nil
        self.admittedLease = nil
        for task in self.expiryTasks.values {
            task.cancel()
        }
        self.expiryTasks.removeAll()
        self.refreshGeneration &+= 1
        self.requests = []
    }

    func refresh() async {
        let generation = self.refreshGeneration
        do {
            let lease = try await self.gateway.acquireServerLease()
            guard generation == self.refreshGeneration, !Task.isCancelled,
                  self.gateway.serverLeaseMatchesCurrentState(lease)
            else { return }
            self.admit(lease)
            await self.reconcile(lease).value
        } catch {
            guard !Task.isCancelled else { return }
            self.logger.error("exec approval listing failed \(error.localizedDescription, privacy: .public)")
        }
    }

    @discardableResult
    private func admit(_ lease: GatewayConnection.ServerLease) -> Bool {
        guard self.admittedLease != lease else { return false }
        self.admittedLease = lease
        self.attentionOwnerID = UUID()
        self.replaceRequests(self.requests.filter { $0.serverLease == lease })
        return true
    }

    private func reconcile(_ lease: GatewayConnection.ServerLease) -> Task<Void, Never> {
        if let pending = self.pendingRefresh, pending.lease == lease {
            return pending.task
        }
        self.pendingRefresh?.task.cancel()
        let task = Task { [weak self] in
            guard !Task.isCancelled, let self else { return }
            defer {
                // A replacement cancels its predecessor before installing its own task.
                if !Task.isCancelled { self.pendingRefresh = nil }
            }
            while !Task.isCancelled, self.gateway.serverLeaseMatchesCurrentState(lease) {
                let generation = self.refreshGeneration
                async let exec = self.listRequests(kind: .exec, lease: lease)
                async let system = self.listRequests(kind: .systemAgent, lease: lease)
                async let plugin = self.listRequests(kind: .plugin, lease: lease)
                let listed = await exec + system + plugin
                guard !Task.isCancelled, self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
                // Reconcile again after newer events so untouched pending rows are still recovered.
                guard generation == self.refreshGeneration else { continue }
                self.replaceRequests(listed.filter { $0.expiresAtMs > Self.currentTimeMs() })
                return
            }
        }
        self.pendingRefresh = (lease, task)
        return task
    }

    private func listRequests(
        kind: ExecApprovalQueueItem.ApprovalKind,
        lease: GatewayConnection.ServerLease) async -> [ExecApprovalQueueItem]
    {
        let method = kind.listMethod
        if kind != .exec,
           await self.gateway.supportsServerMethod(method, ifCurrentServerLease: lease) != true
        {
            return []
        }
        do {
            let data = try await self.gateway.request(
                method: method,
                params: nil,
                timeoutMs: 10000,
                ifCurrentServerLease: lease)
            let requests = try JSONDecoder().decode([ExecApprovalQueueItem].self, from: data)
                .map { $0.owned(by: lease, kind: kind) }
            var presented: [ExecApprovalQueueItem] = []
            for request in requests {
                if let item = await self.present(request, lease: lease) { presented.append(item) }
            }
            return presented
        } catch {
            guard !Task.isCancelled, self.gateway.serverLeaseMatchesCurrentState(lease) else { return [] }
            self.logger.error("""
            approval list failed for \(kind.rawValue, privacy: .public): \(error.localizedDescription, privacy: .public)
            """)
            return self.requests.filter { $0.kind == kind && $0.serverLease == lease }
        }
    }

    private func present(
        _ request: ExecApprovalQueueItem,
        lease: GatewayConnection.ServerLease) async -> ExecApprovalQueueItem?
    {
        guard await self.gateway.supportsServerMethod("approval.get", ifCurrentServerLease: lease) == true else {
            return request
        }
        do {
            let data = try await self.gateway.request(
                method: "approval.get",
                params: ["id": AnyCodable(request.id)],
                timeoutMs: 10000,
                ifCurrentServerLease: lease)
            let result = try JSONDecoder().decode(ApprovalGetResult.self, from: data)
            return request.presenting(result.approval)
        } catch {
            // A transient presentation failure must not hide a still-pending request.
            return request
        }
    }

    func resolve(request: ExecApprovalQueueItem, decision: ExecApprovalDecision) async {
        guard request.allowedDecisions.contains(decision),
              decision != .allowAlways,
              request.expiresAtMs > Self.currentTimeMs(),
              let lease = request.serverLease,
              self.requests.contains(where: { $0.hasSameSource(as: request) && $0.allowedDecisions.contains(decision) })
        else {
            self.logger.info("exec approval decision ignored; request or available decisions changed")
            return
        }

        var params: [String: AnyCodable] = [
            "id": AnyCodable(request.id),
            "decision": AnyCodable(decision.rawValue),
        ]
        let method: GatewayConnection.Method
        switch request.kind {
        case .exec:
            method = .execApprovalResolve
        case .plugin:
            return
        case .systemAgent:
            method = .approvalResolve
            params["kind"] = AnyCodable("system-agent")
        }

        do {
            _ = try await self.gateway.request(
                method: method.rawValue,
                params: params,
                timeoutMs: 10000,
                ifCurrentServerLease: lease)
            self.removeRequest(request)
        } catch {
            self.logger.error("exec approval resolution failed \(error.localizedDescription, privacy: .public)")
            if !self.gateway.serverLeaseMatchesCurrentState(lease) {
                self.removeRequest(request)
            }
            // A losing race (the modal prompter or another client resolved first)
            // surfaces here as a gateway rejection. Re-list instead of parsing
            // error text so the card converges to the authoritative queue.
            await self.refresh()
        }
    }

    private func handle(delivery: GatewayConnection.PushDelivery) {
        let serverLease = delivery.serverLease
        guard let push = delivery.push else {
            // Retirement still clears A's rows while replacement B is unavailable.
            if self.pendingRefresh?.lease == serverLease {
                self.pendingRefresh?.task.cancel()
                self.pendingRefresh = nil
            }
            if self.admittedLease == serverLease { self.admittedLease = nil }
            self.replaceRequests(self.requests.filter { $0.serverLease != serverLease })
            return
        }
        guard delivery.isCurrent else { return }
        // The short hello admission can let current events precede the ordinary snapshot.
        if self.admit(serverLease) {
            _ = self.reconcile(serverLease)
        }
        guard case let .event(event) = push, let payload = event.payload else { return }
        switch event.event {
        case "exec.approval.requested", "plugin.approval.requested", "openclaw.approval.requested":
            do {
                let request = try GatewayPayloadDecoding.decode(payload, as: ExecApprovalQueueItem.self)
                let kind = Self.kind(for: event.event)
                let owned = request.owned(by: serverLease, kind: kind)
                self.insertRequest(owned)
                Task { [weak self] in
                    guard let self else { return }
                    let presented = await self.present(owned, lease: serverLease)
                    guard self.gateway.serverLeaseMatchesCurrentState(serverLease),
                          self.requests.contains(where: { $0.hasSameSource(as: owned) }) else { return }
                    if let presented { self.insertRequest(presented) } else { self.removeRequest(owned) }
                }
            } catch {
                self.logger.error("exec approval event decode failed \(error.localizedDescription, privacy: .public)")
            }
        case "exec.approval.resolved", "plugin.approval.resolved", "openclaw.approval.resolved":
            guard let resolved = try? GatewayPayloadDecoding.decode(payload, as: ResolvedApproval.self) else {
                return
            }
            self.refreshGeneration &+= 1
            let kind = Self.kind(for: event.event)
            if let request = self.requests.first(where: {
                $0.idKey == Data(resolved.id.utf8) && $0.kind == kind && $0.serverLease == serverLease
            }) {
                self.removeRequest(request)
            }
        default:
            break
        }
    }

    private static func kind(for event: String) -> ExecApprovalQueueItem.ApprovalKind {
        if event.hasPrefix("plugin.") { return .plugin }
        return event.hasPrefix("openclaw.") ? .systemAgent : .exec
    }

    private static func oldestFirst(_ lhs: ExecApprovalQueueItem, _ rhs: ExecApprovalQueueItem) -> Bool {
        lhs.createdAtMs == rhs.createdAtMs
            ? lhs.id.utf8.lexicographicallyPrecedes(rhs.id.utf8)
            : lhs.createdAtMs < rhs.createdAtMs
    }

    private func insertRequest(_ request: ExecApprovalQueueItem) {
        guard request.expiresAtMs > Self.currentTimeMs() else { return }
        self.refreshGeneration &+= 1
        self.requests.removeAll { $0.idKey == request.idKey }
        self.requests.append(request)
        self.requests.sort(by: Self.oldestFirst)
        self.scheduleExpiry(for: request)
    }

    private func removeRequest(_ request: ExecApprovalQueueItem) {
        // A retained menu action, timer, or reply must not retire the same id
        // admitted later from another Gateway or physical connection.
        guard let index = self.requests.firstIndex(where: { $0.hasSameSource(as: request) }) else { return }
        self.refreshGeneration &+= 1
        self.requests.remove(at: index)
        self.expiryTasks.removeValue(forKey: request.idKey)?.cancel()
    }

    private func replaceRequests(_ requests: [ExecApprovalQueueItem]) {
        for task in self.expiryTasks.values {
            task.cancel()
        }
        self.expiryTasks.removeAll()
        self.requests = requests.sorted(by: Self.oldestFirst)
        for request in self.requests {
            self.scheduleExpiry(for: request)
        }
    }

    private func scheduleExpiry(for request: ExecApprovalQueueItem) {
        self.expiryTasks.removeValue(forKey: request.idKey)?.cancel()
        let (remainingMs, overflow) = request.expiresAtMs.subtractingReportingOverflow(Self.currentTimeMs())
        guard !overflow, remainingMs > 0 else {
            self.removeRequest(request)
            return
        }
        // Task startup may be delayed; keep the Gateway's expiry deadline.
        let deadline = ContinuousClock.now + .milliseconds(remainingMs)
        self.expiryTasks[request.idKey] = Task { [weak self] in
            try? await Task.sleep(until: deadline, clock: .continuous)
            guard !Task.isCancelled else { return }
            self?.removeRequest(request)
        }
    }

    private static func currentTimeMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private struct ResolvedApproval: Decodable {
        let id: String
    }
}
