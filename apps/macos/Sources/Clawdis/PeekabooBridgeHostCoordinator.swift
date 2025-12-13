import Foundation
import os
import PeekabooAutomationKit
import PeekabooBridge
import PeekabooFoundation

@MainActor
final class PeekabooBridgeHostCoordinator {
    static let shared = PeekabooBridgeHostCoordinator()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "PeekabooBridge")

    private var host: PeekabooBridgeHost?
    private var services: ClawdisPeekabooBridgeServices?

    func setEnabled(_ enabled: Bool) async {
        if enabled {
            await self.startIfNeeded()
        } else {
            await self.stop()
        }
    }

    func stop() async {
        guard let host else { return }
        await host.stop()
        self.host = nil
        self.services = nil
        self.logger.info("PeekabooBridge host stopped")
    }

    private func startIfNeeded() async {
        guard self.host == nil else { return }

        let allowlistedTeamIDs: Set<String> = ["Y5PE65HELJ"]
        let allowlistedBundles: Set<String> = []

        let services = ClawdisPeekabooBridgeServices()
        let server = PeekabooBridgeServer(
            services: services,
            hostKind: .gui,
            allowlistedTeams: allowlistedTeamIDs,
            allowlistedBundles: allowlistedBundles)

        let host = PeekabooBridgeHost(
            socketPath: PeekabooBridgeConstants.clawdisSocketPath,
            server: server,
            allowedTeamIDs: allowlistedTeamIDs,
            requestTimeoutSec: 10)

        self.services = services
        self.host = host

        await host.start()
        self.logger
            .info("PeekabooBridge host started at \(PeekabooBridgeConstants.clawdisSocketPath, privacy: .public)")
    }
}

@MainActor
private final class ClawdisPeekabooBridgeServices: PeekabooBridgeServiceProviding {
    let permissions: PermissionsService
    let screenCapture: any ScreenCaptureServiceProtocol
    let automation: any UIAutomationServiceProtocol
    let windows: any WindowManagementServiceProtocol
    let applications: any ApplicationServiceProtocol
    let menu: any MenuServiceProtocol
    let dock: any DockServiceProtocol
    let dialogs: any DialogServiceProtocol
    let snapshots: any SnapshotManagerProtocol

    init() {
        let logging = LoggingService(subsystem: "com.steipete.clawdis.peekaboo")
        let feedbackClient: any AutomationFeedbackClient = NoopAutomationFeedbackClient()

        let snapshots = InMemorySnapshotManager(options: .init(
            snapshotValidityWindow: 600,
            maxSnapshots: 50,
            deleteArtifactsOnCleanup: false))
        let applications = ApplicationService(feedbackClient: feedbackClient)

        let screenCapture = ScreenCaptureService(loggingService: logging)

        self.permissions = PermissionsService()
        self.snapshots = snapshots
        self.applications = applications
        self.screenCapture = screenCapture
        self.automation = UIAutomationService(
            snapshotManager: snapshots,
            loggingService: logging,
            searchPolicy: .balanced,
            feedbackClient: feedbackClient)
        self.windows = WindowManagementService(applicationService: applications, feedbackClient: feedbackClient)
        self.menu = MenuService(applicationService: applications, feedbackClient: feedbackClient)
        self.dock = DockService(feedbackClient: feedbackClient)
        self.dialogs = DialogService(feedbackClient: feedbackClient)
    }
}
