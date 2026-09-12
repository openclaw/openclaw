import CoreGraphics
import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog

@MainActor
final class ExecApprovalsGatewayPrompter {
    static let shared = ExecApprovalsGatewayPrompter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.gateway")
    private let gateway: GatewayConnection
    private var task: Task<Void, Never>?
    private var promptTasks: [PromptKey: PromptTask] = [:]

    private struct PromptKey: Hashable {
        let id: String
        let kind: ExecApprovalQueueItem.ApprovalKind
        let serverLease: GatewayConnection.ServerLease
    }

    private struct PromptTask {
        let token: UUID
        let task: Task<Void, Never>
        var phase: PromptPhase
    }

    private enum PromptPhase {
        case presenting
        case resolving
    }

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    struct GatewayApprovalRequest: Codable {
        var id: String
        var request: ExecApprovalPromptRequest
        var createdAtMs: Int
        var expiresAtMs: Int
    }

    func start() {
        let gateway = self.gateway
        SimpleTaskSupport.start(task: &self.task) { @MainActor [weak self, gateway] in
            await GatewayPushSubscription.consume(connection: gateway, bufferingNewest: 200) { [weak self] delivery in
                self?.handle(delivery: delivery)
            }
        }
    }

    func stop() {
        SimpleTaskSupport.stop(task: &self.task)
        self.cancelAllPrompts()
    }

    private func handle(delivery: GatewayConnection.PushDelivery) {
        guard let push = delivery.push else {
            self.cancelPrompts(serverLease: delivery.serverLease)
            return
        }
        guard delivery.isCurrent, case let .event(evt) = push, let payload = evt.payload else { return }
        let kind: ExecApprovalQueueItem.ApprovalKind
        switch evt.event {
        case "exec.approval.requested", "exec.approval.resolved":
            kind = .exec
        case "openclaw.approval.requested", "openclaw.approval.resolved":
            kind = .systemAgent
        default:
            return
        }

        if evt.event.hasSuffix(".resolved") {
            guard let resolved = try? GatewayPayloadDecoding.decode(payload, as: ResolvedApproval.self) else {
                return
            }
            // The Gateway echoes our own successful resolution before its RPC response.
            // Dismiss pending UI, but let an in-flight decision observe that response.
            self.cancelPrompt(
                PromptKey(id: resolved.id, kind: kind, serverLease: delivery.serverLease),
                ifPresentingOnly: true)
            return
        }

        do {
            let request = try GatewayPayloadDecoding.decode(payload, as: GatewayApprovalRequest.self)
            // The Gateway emitted this event because its own policy requires a
            // decision. If this Mac cannot present UI, leave the request
            // unresolved so the Gateway applies its current timeout fallback.
            guard self.shouldPresent(request: request) else { return }
            let nowMs = Int(Date().timeIntervalSince1970 * 1000)
            let (remainingMs, overflow) = request.expiresAtMs.subtractingReportingOverflow(nowMs)
            guard !overflow, remainingMs > 0 else { return }
            let key = PromptKey(id: request.id, kind: kind, serverLease: delivery.serverLease)
            guard self.promptTasks[key] == nil else { return }
            let token = UUID()
            let gateway = self.gateway
            let task = Task { [weak self, gateway] in
                guard let self else { return }
                defer { self.finishPrompt(key: key, token: token) }
                await self.present(
                    request: request,
                    kind: kind,
                    key: key,
                    token: token,
                    gateway: gateway)
            }
            self.promptTasks[key] = PromptTask(token: token, task: task, phase: .presenting)
        } catch {
            self.logger.error("exec approval handling failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func present(
        request: GatewayApprovalRequest,
        kind: ExecApprovalQueueItem.ApprovalKind,
        key: PromptKey,
        token: UUID,
        gateway: GatewayConnection) async
    {
        var hasLocalDecision = false
        do {
            let nowMs = Int(Date().timeIntervalSince1970 * 1000)
            let (remainingMs, overflow) = request.expiresAtMs.subtractingReportingOverflow(nowMs)
            guard !overflow, remainingMs > 0 else { return }
            guard let decision = await ExecApprovalsPromptPresenter.prompt(
                request.request,
                timeoutMs: remainingMs,
                isStillEligible: { self.shouldPresent(request: request) })
            else {
                return
            }
            guard gateway.serverLeaseMatchesCurrentState(key.serverLease) else {
                self.logger.info("exec approval decision discarded after the Gateway connection changed")
                return
            }
            var params = ["id": AnyCodable(request.id), "decision": AnyCodable(decision.rawValue)]
            if kind == .systemAgent { params["kind"] = AnyCodable("system-agent") }
            let method: GatewayConnection.Method = kind == .systemAgent ? .approvalResolve : .execApprovalResolve
            hasLocalDecision = true
            self.markResolving(key: key, token: token)
            _ = try await gateway.request(
                method: method.rawValue,
                params: params,
                timeoutMs: 10000,
                ifCurrentServerLease: key.serverLease)
        } catch is CancellationError {
            // Cancellation before a local decision means another owner won. Once the user
            // decides, retain a diagnostic if ownership changes before the RPC completes.
            if hasLocalDecision {
                self.logger.info("exec approval decision discarded after approval ownership changed")
            }
        } catch {
            self.logger.error("exec approval handling failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func cancelPrompt(_ key: PromptKey, ifPresentingOnly: Bool = false) {
        guard let promptTask = self.promptTasks[key], !ifPresentingOnly || promptTask.phase == .presenting else {
            return
        }
        self.promptTasks.removeValue(forKey: key)
        promptTask.task.cancel()
    }

    private func cancelPrompts(serverLease: GatewayConnection.ServerLease) {
        let keys = self.promptTasks.keys.filter { $0.serverLease == serverLease }
        for key in keys {
            self.cancelPrompt(key)
        }
    }

    private func cancelAllPrompts() {
        let tasks = self.promptTasks.values.map(\.task)
        self.promptTasks.removeAll()
        for task in tasks {
            task.cancel()
        }
    }

    private func finishPrompt(key: PromptKey, token: UUID) {
        guard self.promptTasks[key]?.token == token else { return }
        self.promptTasks.removeValue(forKey: key)
    }

    private func markResolving(key: PromptKey, token: UUID) {
        guard self.promptTasks[key]?.token == token else { return }
        self.promptTasks[key]?.phase = .resolving
    }

    private struct ResolvedApproval: Decodable {
        let id: String
    }

    private func shouldPresent(request: GatewayApprovalRequest) -> Bool {
        let mode = AppStateStore.shared.connectionMode
        let activeSession = WebChatManager.shared.activeSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestSession = request.request.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Self.shouldPresent(
            mode: mode,
            activeSession: activeSession,
            requestSession: requestSession,
            lastInputSeconds: Self.lastInputSeconds(),
            thresholdSeconds: 120)
    }

    private static func shouldPresent(
        mode: AppState.ConnectionMode,
        activeSession: String?,
        requestSession: String?,
        lastInputSeconds: Int?,
        thresholdSeconds: Int) -> Bool
    {
        let active = activeSession?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requested = requestSession?.trimmingCharacters(in: .whitespacesAndNewlines)
        let recentlyActive = lastInputSeconds.map { $0 <= thresholdSeconds } ?? (mode == .local)

        if let session = requested, !session.isEmpty {
            if let active, !active.isEmpty {
                return active == session
            }
            return recentlyActive
        }

        if let active, !active.isEmpty {
            return true
        }
        return mode == .local
    }

    private static func lastInputSeconds() -> Int? {
        let anyEvent = CGEventType(rawValue: UInt32.max) ?? .null
        let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyEvent)
        if seconds.isNaN || seconds.isInfinite || seconds < 0 {
            return nil
        }
        return Int(seconds.rounded())
    }
}

#if DEBUG
extension ExecApprovalsGatewayPrompter {
    func _testHandle(deliveries: [GatewayConnection.PushDelivery]) {
        for delivery in deliveries {
            self.handle(delivery: delivery)
        }
    }

    static func _testShouldPresent(
        mode: AppState.ConnectionMode,
        activeSession: String?,
        requestSession: String?,
        lastInputSeconds: Int?,
        thresholdSeconds: Int = 120) -> Bool
    {
        self.shouldPresent(
            mode: mode,
            activeSession: activeSession,
            requestSession: requestSession,
            lastInputSeconds: lastInputSeconds,
            thresholdSeconds: thresholdSeconds)
    }
}
#endif
