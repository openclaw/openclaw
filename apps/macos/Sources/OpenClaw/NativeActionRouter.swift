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
        message: String) async throws -> OpenClawNativePreparedSend
    {
        let (gateway, controller, _) = try await self.present(.session(session))
        guard let transport = controller.gatewayTransport else { throw CancellationError() }
        let lease: OpenClawChatTransportRouteLease
        switch await transport.acquireOutboxRouteLease(ifCurrentServerLease: gateway.lease) {
        case let .available(value):
            lease = value
        case let .unavailable(reason, _):
            throw OpenClawNativeActionError(reason ?? "The selected Gateway is disconnected. Nothing was queued.")
        }
        return try await gateway.actions.prepareSubmission(
            viewModel: controller.viewModel,
            session: session,
            message: message,
            lease: lease,
            presentationIsCurrent: { [weak windows = self.windows, weak controller] in
                guard let windows, let controller else { return false }
                return windows.nativePresentationIsCurrent(controller, gateway: gateway, session: session) &&
                    controller.hasPresentedNative(.session(session))
            })
    }

    func inspect(_ run: OpenClawNativeRunRef) async throws -> OpenClawNativeRunInspection {
        let (_, _, inspection) = try await self.present(.inspect(run))
        guard let inspection else { throw CancellationError() }
        return inspection
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
        guard !self.presenting else {
            throw OpenClawNativeActionError("Another native action is opening a chat. Try again when it finishes.")
        }
        self.presenting = true
        defer { self.presenting = false }
        let gateway = try await self.windows.captureNativeGateway(gatewayID: request.session.owner.gatewayID)
        let run: OpenClawNativeRunRef? = if case let .inspect(run) = request {
            run
        } else { nil }
        let history = try await gateway.actions.history(session: request.session, runID: run?.runID)
        let inspection = try run.map { try OpenClawChatNativeRunInspection.reduce(history, run: $0) }
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
