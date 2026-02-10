import OpenClawKit
import OpenClawProtocol
import CoreGraphics
import Foundation
import OSLog

@MainActor
final class ExecApprovalsGatewayPrompter {
    static let shared = ExecApprovalsGatewayPrompter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.gateway")
    private var task: Task<Void, Never>?

    struct GatewayApprovalRequest: Codable, Sendable {
        var id: String
        var request: ExecApprovalPromptRequest
        var createdAtMs: Int
        var expiresAtMs: Int
    }

    func start() {
        guard self.task == nil else { return }
        self.task = Task { [weak self] in
            await self?.run()
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }

    private func run() async {
        let stream = await GatewayConnection.shared.subscribe(bufferingNewest: 200)
        for await push in stream {
            if Task.isCancelled { return }
            await self.handle(push: push)
        }
    }

    private func handle(push: GatewayPush) async {
        guard case let .event(evt) = push else { return }
        guard evt.event == "exec.approval.requested" else { return }
        guard let payload = evt.payload else { return }
        do {
            let data = try JSONEncoder().encode(payload)
            let request = try JSONDecoder().decode(GatewayApprovalRequest.self, from: data)
            let presentation = self.shouldPresent(request: request)
            guard presentation.needsApproval else {
                // Policy says no approval needed – auto-approve
                try await GatewayConnection.shared.requestVoid(
                    method: .execApprovalResolve,
                    params: [
                        "id": AnyCodable(request.id),
                        "decision": AnyCodable("allow-once"),
                    ],
                    timeoutMs: 10000)
                return
            }
            guard presentation.canPresent else {
                // Can't show prompt – use askFallback policy
                let decision: String = presentation.askFallback == .full ? "allow-once" : "deny"
                try await GatewayConnection.shared.requestVoid(
                    method: .execApprovalResolve,
                    params: [
                        "id": AnyCodable(request.id),
                        "decision": AnyCodable(decision),
                    ],
                    timeoutMs: 10000)
                return
            }
            let decision = ExecApprovalsPromptPresenter.prompt(request.request)
            try await GatewayConnection.shared.requestVoid(
                method: .execApprovalResolve,
                params: [
                    "id": AnyCodable(request.id),
                    "decision": AnyCodable(decision.rawValue),
                ],
                timeoutMs: 10000)
        } catch {
            self.logger.error("exec approval handling failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func needsApproval(security: ExecSecurity, ask: ExecAsk) -> Bool {
        switch ask {
        case .always:
            return true
        case .onMiss:
            return security == .allowlist
        case .off:
            return false
        }
    }

    struct PresentationDecision {
        var needsApproval: Bool
        var canPresent: Bool
        var askFallback: ExecSecurity
    }

    private func shouldPresent(request: GatewayApprovalRequest) -> PresentationDecision {
        let mode = AppStateStore.shared.connectionMode
        let activeSession = WebChatManager.shared.activeSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestSession = request.request.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        
        // Check exec-approvals.json settings (use per-agent resolved config)
        let approvals = ExecApprovalsStore.resolve(agentId: request.request.agentId)
        let security = approvals.agent.security
        let ask = approvals.agent.ask
        
        let needsApproval = Self.needsApproval(security: security, ask: ask)
        
        let canPresent = needsApproval && Self.shouldPresent(
            mode: mode,
            activeSession: activeSession,
            requestSession: requestSession,
            lastInputSeconds: Self.lastInputSeconds(),
            thresholdSeconds: 120)
        
        return PresentationDecision(
            needsApproval: needsApproval,
            canPresent: canPresent,
            askFallback: approvals.agent.askFallback)
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
        if seconds.isNaN || seconds.isInfinite || seconds < 0 { return nil }
        return Int(seconds.rounded())
    }
}

#if DEBUG
extension ExecApprovalsGatewayPrompter {
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

    static func _testNeedsApproval(security: ExecSecurity, ask: ExecAsk) -> Bool {
        self.needsApproval(security: security, ask: ask)
    }
}
#endif
