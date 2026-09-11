import CoreGraphics
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

@MainActor
final class ExecApprovalsGatewayPrompter {
    static let shared = ExecApprovalsGatewayPrompter(gateway: .shared) {
        WebChatManager.shared.approvalContext(connection: .shared)
    }

    struct PresentationContext: Equatable {
        let mode: AppState.ConnectionMode
        let sessionKey: String?
        let agentID: String?
        let windowID: ObjectIdentifier?
        let nativeBinding: MacGatewayChatTransport.NativeBinding?

        init(
            mode: AppState.ConnectionMode,
            sessionKey: String?,
            agentID: String?,
            windowID: ObjectIdentifier?,
            nativeBinding: MacGatewayChatTransport.NativeBinding? = nil)
        {
            self.mode = mode
            self.sessionKey = sessionKey
            self.agentID = agentID
            self.windowID = windowID
            self.nativeBinding = nativeBinding
        }

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.mode == rhs.mode && lhs.windowID == rhs.windowID && lhs.nativeBinding == rhs.nativeBinding &&
                lhs.sessionKey.map { Data($0.utf8) } == rhs.sessionKey.map { Data($0.utf8) } &&
                lhs.agentID.map { Data($0.utf8) } == rhs.agentID.map { Data($0.utf8) }
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.gateway")
    private let gateway: GatewayConnection
    private let presentationContext: @MainActor () -> PresentationContext?
    private var task: Task<Void, Never>?

    init(
        gateway: GatewayConnection,
        presentationContext: @escaping @MainActor () -> PresentationContext?)
    {
        self.gateway = gateway
        self.presentationContext = presentationContext
    }

    struct GatewayApprovalRequest: Codable {
        var id: String
        var request: ExecApprovalPromptRequest
        var createdAtMs: Int
        var expiresAtMs: Int
    }

    func start() {
        SimpleTaskSupport.start(task: &self.task) { [weak self] in
            await self?.run()
        }
    }

    func stop() {
        SimpleTaskSupport.stop(task: &self.task)
    }

    private func run() async {
        let stream = await self.gateway.subscribe(bufferingNewest: 200)
        for await delivery in stream {
            if Task.isCancelled {
                return
            }
            await self.handle(delivery: delivery)
        }
    }

    private func handle(delivery: GatewayConnection.PushDelivery) async {
        guard delivery.isCurrent, let push = delivery.push, case let .event(evt) = push else { return }
        guard evt.event == "exec.approval.requested" || evt.event == "openclaw.approval.requested" else { return }
        guard let payload = evt.payload else { return }
        do {
            let data = try JSONEncoder().encode(payload)
            let request = try JSONDecoder().decode(GatewayApprovalRequest.self, from: data)
            // The Gateway emitted this event because its own policy requires a
            // decision. If this Mac cannot present UI, leave the request
            // unresolved so the Gateway applies its current timeout fallback.
            guard let context = self.presentationContext(),
                  Self.shouldPresent(request: request, context: context),
                  context.nativeBinding.map({
                      $0.lease == delivery.serverLease &&
                          evt.recipientprofileid?.utf8.elementsEqual($0.owner.profileID.utf8) == true
                  }) ?? true
            else { return }
            let nowMs = Int(Date().timeIntervalSince1970 * 1000)
            let (remainingMs, overflow) = request.expiresAtMs.subtractingReportingOverflow(nowMs)
            guard !overflow, remainingMs > 0 else { return }
            let validate: (@MainActor () async -> Bool)? = if context.nativeBinding != nil {
                { @MainActor in await self.validateNativeContext(context, delivery: delivery) }
            } else {
                nil
            }
            guard let decision = await ExecApprovalsPromptPresenter.prompt(
                request.request,
                timeoutMs: remainingMs,
                presentingWindowID: context.nativeBinding == nil ? nil : context.windowID,
                validateBeforePresentation: validate)
            else {
                return
            }
            // A profile can share a connection across windows. A decision from
            // a replaced or retargeted window must not resolve another chat's request.
            guard !Task.isCancelled, delivery.isCurrent, self.presentationContext() == context else {
                self.logger.info("exec approval decision discarded after its Gateway or chat changed")
                return
            }
            if context.nativeBinding != nil, await !(self.validateNativeContext(context, delivery: delivery)) {
                return
            }
            let isSystemAgent = evt.event == "openclaw.approval.requested"
            var params = ["id": AnyCodable(request.id), "decision": AnyCodable(decision.rawValue)]
            if isSystemAgent { params["kind"] = AnyCodable("system-agent") }
            let method: GatewayConnection.Method = isSystemAgent ? .approvalResolve : .execApprovalResolve
            _ = try await self.gateway.request(
                method: method.rawValue,
                params: params,
                timeoutMs: 10000,
                ifCurrentServerLease: delivery.serverLease,
                expectedProfileId: context.nativeBinding?.owner.profileID)
        } catch {
            self.logger.error("exec approval handling failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func validateNativeContext(
        _ context: PresentationContext,
        delivery: GatewayConnection.PushDelivery) async -> Bool
    {
        guard let binding = context.nativeBinding, delivery.isCurrent,
              binding.lease == delivery.serverLease, self.presentationContext() == context
        else { return false }
        do {
            let gateway = OpenClawChatNativeActionGateway(
                gatewayID: binding.owner.gatewayID,
                gatewayName: "",
                supportsProfileBinding: {
                    await self.gateway.supportsServerCapability(
                        .profileBinding, ifCurrentServerLease: binding.lease) == true
                },
                request: { request, expectedProfileId in
                    try await self.gateway.request(
                        request,
                        ifCurrentServerLease: binding.lease,
                        expectedProfileId: expectedProfileId)
                },
                isCurrent: { await self.gateway.isCurrentServerLease(binding.lease) })
            _ = try await gateway.owner(expected: binding.owner)
            return !Task.isCancelled && delivery.isCurrent && self.presentationContext() == context
        } catch {
            return false
        }
    }

    static func shouldPresent(request: GatewayApprovalRequest, context: PresentationContext) -> Bool {
        if context.nativeBinding != nil {
            // Selected UI context is not request-origin proof. Unknown target
            // facts cannot use the ordinary recent-activity fallback.
            guard let agentID = context.agentID, let sessionKey = context.sessionKey else { return false }
            return request.request.agentId?.utf8.elementsEqual(agentID.utf8) == true &&
                request.request.sessionKey?.utf8.elementsEqual(sessionKey.utf8) == true
        }
        if let requestedAgent = request.request.agentId, let activeAgent = context.agentID,
           !requestedAgent.utf8.elementsEqual(activeAgent.utf8)
        { return false }
        let requestSession = request.request.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Self.shouldPresent(
            mode: context.mode,
            activeSession: context.sessionKey,
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
                return active.utf8.elementsEqual(session.utf8)
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
