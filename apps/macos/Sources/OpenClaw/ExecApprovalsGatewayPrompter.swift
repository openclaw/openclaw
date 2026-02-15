import CoreGraphics
import Foundation
import OpenClawKit
import OpenClawProtocol
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
            guard presentation.shouldAsk else {
                // Ask policy says no prompt needed – resolve based on security policy
                let decision: ExecApprovalDecision = presentation.security == .full ? .allowOnce : .deny
                try await GatewayConnection.shared.requestVoid(
                    method: .execApprovalResolve,
                    params: [
                        "id": AnyCodable(request.id),
                        "decision": AnyCodable(decision.rawValue),
                    ],
                    timeoutMs: 10000)
                return
            }
            guard presentation.canPresent else {
                // Can't show prompt – use askFallback policy
                let decision: ExecApprovalDecision = presentation.askFallback == .full ? .allowOnce : .deny
                try await GatewayConnection.shared.requestVoid(
                    method: .execApprovalResolve,
                    params: [
                        "id": AnyCodable(request.id),
                        "decision": AnyCodable(decision.rawValue),
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

    /// Whether the ask policy requires prompting the user.
    /// Note: this only determines if a prompt is shown, not whether the action is allowed.
    /// The security policy (full/deny/allowlist) decides the actual outcome.
    private static func shouldAsk(security: ExecSecurity, ask: ExecAsk) -> Bool {
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
        /// Whether the ask policy requires prompting the user (not whether the action is allowed).
        var shouldAsk: Bool
        /// Whether the prompt can actually be shown (session match, recent activity, etc.).
        var canPresent: Bool
        /// The resolved security policy, used to determine allow/deny when no prompt is shown.
        var security: ExecSecurity
        /// Fallback security policy when a prompt is needed but can't be presented.
        var askFallback: ExecSecurity
    }

    private func shouldPresent(request: GatewayApprovalRequest) -> PresentationDecision {
        let mode = AppStateStore.shared.connectionMode
        let activeSession = WebChatManager.shared.activeSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestSession = request.request.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        
        // Read-only resolve to avoid disk writes on the MainActor
        let approvals = ExecApprovalsStore.resolveReadOnly(agentId: request.request.agentId)
        let security = approvals.agent.security
        let ask = approvals.agent.ask
        
        let shouldAsk = Self.shouldAsk(security: security, ask: ask)
        
        let canPresent = shouldAsk && Self.shouldPresent(
            mode: mode,
            activeSession: activeSession,
            requestSession: requestSession,
            lastInputSeconds: Self.lastInputSeconds(),
            thresholdSeconds: 120)
        
        return PresentationDecision(
            shouldAsk: shouldAsk,
            canPresent: canPresent,
            security: security,
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

    static func _testShouldAsk(security: ExecSecurity, ask: ExecAsk) -> Bool {
        self.shouldAsk(security: security, ask: ask)
    }
}
#endif
