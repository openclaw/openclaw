import AppIntents
import Foundation
import OpenClawChatUI
import OpenClawKit

extension OpenClawApp: AppIntentsPackage {
    nonisolated static var includedPackages: [any AppIntentsPackage.Type] {
        [OpenClawNativeAppIntents.self]
    }
}

struct OpenClawShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CheckSessionStatusIntent(),
            phrases: ["Check status in \(.applicationName)"],
            shortTitle: "Check Status",
            systemImageName: "clock.badge.checkmark")
        AppShortcut(
            intent: AskOpenClawIntent(),
            phrases: ["Ask \(.applicationName)"],
            shortTitle: "Ask OpenClaw",
            systemImageName: "text.bubble")
        AppShortcut(
            intent: OpenSessionIntent(),
            phrases: ["Open a session in \(.applicationName)"],
            shortTitle: "Open Session",
            systemImageName: "bubble.left.and.bubble.right")
        AppShortcut(
            intent: OpenComposeIntent(),
            phrases: ["Compose a message in \(.applicationName)"],
            shortTitle: "Compose Message",
            systemImageName: "square.and.pencil")
        AppShortcut(
            intent: SendMessageIntent(),
            phrases: ["Send a message with \(.applicationName)"],
            shortTitle: "Send Message",
            systemImageName: "paperplane")
        AppShortcut(
            intent: InspectRunIntent(),
            phrases: ["Inspect a run in \(.applicationName)"],
            shortTitle: "Inspect Run",
            systemImageName: "clock")
    }
}

@MainActor
final class NativeActionRouter: OpenClawNativeActionHost {
    private let windows: WebChatManager
    private let launchPlan: AppLaunchRuntimePlan
    private var presenting = false
    private var continuation: RunContinuation?

    @MainActor
    private final class RunContinuation {
        let id = UUID()
        let gateway: WebChatManager.NativeGateway
        weak var controller: WebChatSwiftUIWindowController?
        let session: OpenClawNativeSessionRef
        let presentationID: UUID

        init(
            gateway: WebChatManager.NativeGateway,
            controller: WebChatSwiftUIWindowController,
            session: OpenClawNativeSessionRef)
        {
            self.gateway = gateway
            self.controller = controller
            self.session = session
            self.presentationID = controller.nativePresentationID
        }
    }

    init(windows: WebChatManager = .shared, launchPlan: AppLaunchRuntimePlan = .current) {
        self.windows = windows
        self.launchPlan = launchPlan
    }

    func sessions(matching query: String?) async throws -> [OpenClawNativeSessionChoice] {
        try self.requireAvailable()
        let gateway = try await self.windows.captureNativeGateway()
        return try await gateway.actions.sessions(matching: query)
    }

    func runs(matching query: String?) async throws -> [OpenClawNativeRunRef] {
        try self.requireAvailable()
        let gateway = try await self.windows.captureNativeGateway()
        return try await gateway.actions.runs(matching: query)
    }

    func open(_ request: OpenClawNativeOpenRequest) async -> OpenClawNativeOpenOutcome {
        do {
            _ = try await self.present(request)
            return .opened
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unavailable(reason: error.localizedDescription)
        }
    }

    func prepareSend(
        to session: OpenClawNativeSessionRef,
        message: String) async throws -> (send: OpenClawNativePreparedSend, presentationContinuationID: UUID)
    {
        let (gateway, controller, _) = try await self.present(.session(session))
        guard let transport = controller.gatewayTransport else { throw CancellationError() }
        let continuation = RunContinuation(gateway: gateway, controller: controller, session: session)
        self.continuation = continuation
        let lease: OpenClawChatTransportRouteLease
        switch await transport.acquireOutboxRouteLease(ifCurrentServerLease: gateway.lease) {
        case let .available(value):
            lease = value
        case let .unavailable(reason, _):
            throw OpenClawNativeActionError(reason ?? "The selected Gateway is disconnected. Nothing was queued.")
        }
        let prepared = try await gateway.actions(observing: transport).prepareSubmission(
            viewModel: controller.viewModel,
            session: session,
            message: message,
            lease: lease,
            accountIsCurrent: {
                guard transport.nativeBindingIsCurrent else { return false }
                return await gateway.connection.isCurrentServerLease(gateway.lease)
            },
            presentationIsCurrent: { [weak windows = self.windows, weak controller] in
                guard let windows, let controller else { return false }
                return windows.nativePresentationIsCurrent(controller, gateway: gateway, session: session) &&
                    controller.nativePresentationID == continuation.presentationID &&
                    controller.hasPresentedNative(.session(session))
            })
        return (prepared, continuation.id)
    }

    func sessionStatus(_ session: OpenClawNativeSessionRef) async throws -> String {
        try self.requireAvailable()
        let gateway = try await self.windows.captureNativeGateway(gatewayID: session.owner.gatewayID)
        return try await gateway.actions.sessionStatus(session)
    }

    func inspect(_ run: OpenClawNativeRunRef) async throws
    -> (inspection: OpenClawNativeRunInspection, presentationContinuationID: UUID) {
        let (gateway, controller, inspection) = try await self.present(.inspect(run))
        guard let inspection else { throw CancellationError() }
        let continuation = RunContinuation(gateway: gateway, controller: controller, session: run.session)
        self.continuation = continuation
        return (inspection, continuation.id)
    }

    func openRun(_ run: OpenClawNativeRunRef, continuing id: UUID) async throws -> OpenClawNativeRunOpenOutcome {
        try self.requireAvailable()
        guard let continuation = self.continuation, continuation.id == id, continuation.session == run.session,
              let controller = continuation.controller,
              controller.nativePresentationID == continuation.presentationID,
              self.windows.nativePresentationIsCurrent(controller, gateway: continuation.gateway, session: run.session),
              await continuation.gateway.connection.isCurrentServerLease(continuation.gateway.lease)
        else { return .skipped }
        let inspection = try await continuation.gateway.actions(observing: controller.gatewayTransport)
            .validatePresentation(.inspect(run))
        try Task.checkCancellation()
        guard controller.nativePresentationID == continuation.presentationID,
              self.windows.nativePresentationIsCurrent(controller, gateway: continuation.gateway, session: run.session),
              inspection?.run == run
        else { return .skipped }
        try controller.presentNative(.inspect(run))
        return .opened
    }

    private func requireAvailable() throws {
        try Task.checkCancellation()
        guard !self.launchPlan.isElevationHost else {
            throw OpenClawNativeActionError("Run this action from the interactive OpenClaw app.")
        }
    }

    private func present(
        _ request: OpenClawNativeOpenRequest) async throws
        -> (WebChatManager.NativeGateway, WebChatSwiftUIWindowController, OpenClawNativeRunInspection?)
    {
        try self.requireAvailable()
        if case .liveVoice = request {
            throw OpenClawNativeActionError("Start Talk Mode from the primary Gateway chat on this Mac.")
        }
        guard !self.presenting else {
            throw OpenClawNativeActionError("Another native action is opening a chat. Try again when it finishes.")
        }
        self.presenting = true
        defer { self.presenting = false }
        let gateway = try await self.windows.captureNativeGateway(gatewayID: request.session.owner.gatewayID)
        let inspection = try await gateway.actions.validatePresentation(request)
        guard await gateway.connection.isCurrentServerLease(gateway.lease) else { throw CancellationError() }
        let controller = try self.windows.presentNative(request, gateway: gateway)
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            guard await gateway.connection.isCurrentServerLease(gateway.lease),
                  self.windows.nativePresentationIsCurrent(controller, gateway: gateway, session: request.session)
            else { throw CancellationError() }
            if controller.hasPresentedNative(request),
               !controller.viewModel.isLoading, controller.viewModel.healthOK
            {
                return (gateway, controller, inspection)
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw OpenClawNativeActionError("The selected chat is not ready. Open it and try again.")
    }
}
