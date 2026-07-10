import AppKit
import CryptoKit
import Observation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

enum UIStrings {
    static let welcomeTitle = "Welcome to OpenClaw"
}

enum RemoteOnboardingProbeState: Equatable {
    case idle
    case checking
    case ok(RemoteGatewayProbeSuccess)
    case failed(String)
}

enum OnboardingCrestodianResumeStore {
    enum PendingState: Equatable {
        case none
        case activating(deadline: Date)
        case verified(deadline: Date)
        case activationExpired
        case completed
    }

    private enum RecordPhase: String {
        case activating
        case verified
        case completed
    }

    private struct Record {
        let phase: RecordPhase
        let startedAt: Date?
        let deadline: Date?
    }

    private static let recordVersion = 2
    private static let legacyRecordVersion = 1
    private static let activationDeadlineSafetySeconds: TimeInterval = 5
    static let maximumActivationTimeoutMs: Double = 480_000
    /// Legacy string markers do not say whether activation returned. Waiting
    /// one full maximum request window is the only safe migration.
    static let legacyActivationLeaseSeconds: TimeInterval =
        maximumActivationTimeoutMs / 1000 + activationDeadlineSafetySeconds

    @MainActor
    static func selectedRouteIdentity(
        state: AppState = AppStateStore.shared,
        preferredGatewayID: String? = GatewayDiscoveryPreferences.preferredStableID()) -> String?
    {
        let defaultRemotePort = GatewayEnvironment.gatewayPort()
        let sshRemotePort: Int = if state.connectionMode == .remote,
                                    state.remoteTransport == .ssh
        {
            RemotePortTunnel.resolveRemotePortOverride(
                defaultRemotePort: defaultRemotePort,
                for: CommandResolver.parseSSHTarget(state.remoteTarget)?.host ?? "") ?? defaultRemotePort
        } else {
            defaultRemotePort
        }
        return self.routeIdentity(
            connectionMode: state.connectionMode,
            preferredGatewayID: preferredGatewayID,
            remoteTransport: state.remoteTransport,
            remoteURL: state.remoteUrl,
            remoteTarget: state.remoteTarget,
            localStateDir: OpenClawConfigFile.stateDirURL(),
            sshRemotePort: sshRemotePort)
    }

    static func routeIdentity(
        connectionMode: AppState.ConnectionMode,
        preferredGatewayID: String?,
        remoteTransport: AppState.RemoteTransport,
        remoteURL: String,
        remoteTarget: String,
        localStateDir: URL = OpenClawConfigFile.stateDirURL(),
        sshRemotePort: Int = GatewayEnvironment.gatewayPort()) -> String?
    {
        switch connectionMode {
        case .unconfigured:
            return nil
        case .local:
            let stateDir = localStateDir.resolvingSymlinksInPath().standardizedFileURL.path
            let defaultStateDir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".openclaw", isDirectory: true)
                .resolvingSymlinksInPath()
                .standardizedFileURL.path
            if stateDir == defaultStateDir {
                return "local"
            }
            return "local:\(self.nonSecretFingerprint(stateDir))"
        case .remote:
            if let gatewayID = normalized(preferredGatewayID) {
                return "remote:id:\(gatewayID)"
            }
            let endpoint = switch remoteTransport {
            case .direct:
                self.nonSecretFingerprint(self.directEndpointIdentity(remoteURL))
            case .ssh:
                self.nonSecretFingerprint("\(remoteTarget):gateway-port:\(sshRemotePort)")
            }
            return "remote:\(remoteTransport.rawValue):\(endpoint)"
        }
    }

    static func isPending(
        for routeIdentity: String?,
        defaults: UserDefaults = .standard,
        now: Date = Date()) -> Bool
    {
        self.pendingState(for: routeIdentity, defaults: defaults, now: now) != .none
    }

    static func markPending(
        routeIdentity: String?,
        activationTimeoutMs: Double = OnboardingCrestodianResumeStore.maximumActivationTimeoutMs,
        defaults: UserDefaults = .standard,
        now: Date = Date())
    {
        guard let routeIdentity = normalized(routeIdentity) else { return }
        let duration = max(0, activationTimeoutMs / 1000) + self.activationDeadlineSafetySeconds
        var records = self.loadRecords(defaults: defaults, now: now)
        records[routeIdentity] = Record(
            phase: .activating,
            startedAt: now,
            deadline: now.addingTimeInterval(duration))
        self.writeRecords(records, defaults: defaults)
    }

    static func markVerified(
        ifOwnedBy routeIdentity: String?,
        defaults: UserDefaults = .standard,
        now: Date = Date())
    {
        guard let routeIdentity = normalized(routeIdentity) else { return }
        var records = self.loadRecords(defaults: defaults, now: now)
        guard let record = records[routeIdentity] else { return }
        records[routeIdentity] = Record(
            phase: .verified,
            startedAt: record.startedAt,
            deadline: record.deadline ?? now.addingTimeInterval(self.legacyActivationLeaseSeconds))
        self.writeRecords(records, defaults: defaults)
    }

    static func markCompleted(
        ifOwnedBy routeIdentity: String?,
        defaults: UserDefaults = .standard,
        now: Date = Date())
    {
        guard let routeIdentity = normalized(routeIdentity) else { return }
        var records = self.loadRecords(defaults: defaults, now: now)
        guard let record = records[routeIdentity] else { return }
        records[routeIdentity] = Record(
            phase: .completed,
            startedAt: record.startedAt,
            deadline: record.deadline)
        self.writeRecords(records, defaults: defaults)
    }

    static func pendingState(
        for routeIdentity: String?,
        defaults: UserDefaults = .standard,
        now: Date = Date()) -> PendingState
    {
        guard let routeIdentity = normalized(routeIdentity),
              let record = self.loadRecords(defaults: defaults, now: now)[routeIdentity]
        else { return .none }

        switch record.phase {
        case .completed:
            return .completed
        case .activating, .verified:
            guard let deadline = record.deadline else { return .activationExpired }
            guard now < deadline else { return .activationExpired }
            return record.phase == .activating
                ? .activating(deadline: deadline)
                : .verified(deadline: deadline)
        }
    }

    static func clear(
        ifOwnedBy routeIdentity: String,
        defaults: UserDefaults = .standard)
    {
        guard let routeIdentity = self.normalized(routeIdentity) else { return }
        var records = self.loadRecords(defaults: defaults)
        guard records.removeValue(forKey: routeIdentity) != nil else { return }
        self.writeRecords(records, defaults: defaults)
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: onboardingCrestodianPendingKey)
    }

    private static func loadRecords(
        defaults: UserDefaults,
        now: Date = Date()) -> [String: Record]
    {
        guard let stored = defaults.object(forKey: onboardingCrestodianPendingKey) else { return [:] }
        if let legacyRoute = normalized(stored as? String) {
            let records = [legacyRoute: self.conservativeLegacyRecord(now: now)]
            self.writeRecords(records, defaults: defaults)
            return records
        }
        guard let container = stored as? [String: Any] else {
            self.clear(defaults: defaults)
            return [:]
        }
        let version = (container["version"] as? NSNumber)?.intValue
        if version == self.legacyRecordVersion,
           let routeIdentity = normalized(container["routeIdentity"] as? String)
        {
            let record = self.decodeLegacyRecord(container, now: now)
            let records = [routeIdentity: record]
            self.writeRecords(records, defaults: defaults)
            return records
        }
        guard version == self.recordVersion,
              let storedRecords = container["records"] as? [String: Any]
        else {
            self.clear(defaults: defaults)
            return [:]
        }
        return storedRecords.reduce(into: [:]) { result, entry in
            guard let routeIdentity = normalized(entry.key),
                  let payload = entry.value as? [String: Any],
                  let record = self.decodeRecord(payload)
            else { return }
            result[routeIdentity] = record
        }
    }

    private static func decodeLegacyRecord(_ payload: [String: Any], now: Date) -> Record {
        guard let phaseRaw = payload["phase"] as? String,
              let phase = RecordPhase(rawValue: phaseRaw)
        else { return self.conservativeLegacyRecord(now: now) }
        let startedAt = self.date(payload["startedAt"])
        let deadline = self.date(payload["deadlineAt"])
        switch phase {
        case .activating:
            return Record(
                phase: .activating,
                startedAt: startedAt ?? now,
                deadline: deadline ?? now.addingTimeInterval(self.legacyActivationLeaseSeconds))
        case .verified, .completed:
            // v1 `verified` could be written by an early read-only probe and
            // carried no deadline, so migration must restore a full lease.
            return Record(
                phase: .verified,
                startedAt: startedAt ?? now,
                deadline: deadline ?? now.addingTimeInterval(self.legacyActivationLeaseSeconds))
        }
    }

    private static func conservativeLegacyRecord(now: Date) -> Record {
        Record(
            phase: .activating,
            startedAt: now,
            deadline: now.addingTimeInterval(self.legacyActivationLeaseSeconds))
    }

    private static func decodeRecord(_ payload: [String: Any]) -> Record? {
        guard let phaseRaw = payload["phase"] as? String,
              let phase = RecordPhase(rawValue: phaseRaw)
        else { return nil }
        return Record(
            phase: phase,
            startedAt: self.date(payload["startedAt"]),
            deadline: self.date(payload["deadlineAt"]))
    }

    private static func writeRecords(_ records: [String: Record], defaults: UserDefaults) {
        guard !records.isEmpty else {
            self.clear(defaults: defaults)
            return
        }
        let payload = records.mapValues { record -> [String: Any] in
            var value: [String: Any] = ["phase": record.phase.rawValue]
            if let startedAt = record.startedAt {
                value["startedAt"] = startedAt.timeIntervalSince1970
            }
            if let deadline = record.deadline {
                value["deadlineAt"] = deadline.timeIntervalSince1970
            }
            return value
        }
        defaults.set(
            ["version": self.recordVersion, "records": payload],
            forKey: onboardingCrestodianPendingKey)
    }

    private static func date(_ value: Any?) -> Date? {
        guard let interval = (value as? NSNumber)?.doubleValue else { return nil }
        return Date(timeIntervalSince1970: interval)
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    private static func nonSecretFingerprint(_ value: String) -> String {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return "" }
        let digest = SHA256.hash(data: Data(raw.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func directEndpointIdentity(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = GatewayRemoteConfig.normalizeGatewayUrlString(trimmed) ?? trimmed
        guard var components = URLComponents(string: normalized) else { return normalized }
        // Auth can rotate while an activation is still committing. The durable
        // lease follows the endpoint, while route-bound RPCs separately guard auth.
        components.user = nil
        components.password = nil
        components.queryItems = components.queryItems?.filter { queryItem in
            !self.isSensitiveQueryItemName(queryItem.name)
        }
        if components.queryItems?.isEmpty == true {
            components.query = nil
        }
        components.fragment = nil
        return components.string ?? normalized
    }

    private static func isSensitiveQueryItemName(_ value: String) -> Bool {
        let normalized = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
        return [
            "access_token",
            "api_key",
            "apikey",
            "app_secret",
            "auth",
            "auth_token",
            "authorization",
            "client_secret",
            "code",
            "credential",
            "hook_token",
            "id_token",
            "jwt",
            "key",
            "pass",
            "passwd",
            "password",
            "private_key",
            "refresh_token",
            "secret",
            "session",
            "signature",
            "token",
            "x_amz_security_token",
            "x_amz_signature",
        ].contains(normalized)
    }
}

@MainActor
final class OnboardingController: NSObject, NSWindowDelegate {
    static let shared = OnboardingController()
    private var window: NSWindow?
    /// Human description of work in flight ("Installing the Gateway…").
    /// While set, closing the window asks for confirmation instead of quitting
    /// setup mid-operation.
    var busyReason: String?

    static func markComplete(clearSelectedRouteResume: Bool = true) {
        UserDefaults.standard.set(true, forKey: onboardingSeenKey)
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = true
        if clearSelectedRouteResume,
           let routeIdentity = OnboardingCrestodianResumeStore.selectedRouteIdentity()
        {
            OnboardingCrestodianResumeStore.clear(ifOwnedBy: routeIdentity)
        }
    }

    func show() {
        if ProcessInfo.processInfo.isNixMode {
            // Nix mode is fully declarative; onboarding would suggest interactive setup that doesn't apply.
            Self.markComplete()
            return
        }
        if let window {
            DockIconManager.shared.temporarilyShowDock()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: OnboardingView())
        let window = NSWindow(contentViewController: hosting)
        window.title = UIStrings.welcomeTitle
        window.setContentSize(NSSize(width: OnboardingView.windowWidth, height: OnboardingView.windowHeight))
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.delegate = self
        window.center()
        DockIconManager.shared.temporarilyShowDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func close() {
        self.busyReason = nil
        self.window?.close()
        self.window = nil
    }

    func setWindowCloseEnabled(_ enabled: Bool) {
        self.window?.standardWindowButton(.closeButton)?.isEnabled = enabled
    }

    func restart() {
        self.close()
        self.show()
    }

    func windowShouldClose(_: NSWindow) -> Bool {
        guard let busyReason else { return true }
        let alert = NSAlert()
        alert.messageText = "Setup is still working"
        alert.informativeText =
            "\(busyReason)\n\nYou can keep this window open until it finishes, " +
            "or quit setup and pick it up again later from the menu bar."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Continue Setup")
        alert.addButton(withTitle: "Quit Setup")
        let response = alert.runModal()
        return response == .alertSecondButtonReturn
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow, closing === window else { return }
        self.busyReason = nil
        self.window = nil
    }
}

struct OnboardingView: View {
    enum CLIInstallPhase {
        case idle
        case installing
        case startingService
    }

    @State var currentPage = 0
    @State var isRequesting = false
    @State var installingCLI = false
    @State var cliInstallPhase: CLIInstallPhase = .idle
    @State var cliStatus: String?
    @State var monitoringPermissions = false
    @State var monitoringDiscovery = false
    @State var cliInstalled = false
    @State var cliStatusKnown = false
    @State var onboardingVisible = false
    @State var cliInstallLocation: String?
    @State var showAdvancedConnection = false
    @State var showRemoteChoices = false
    @State var preferredGatewayID: String?
    @State var remoteProbeState: RemoteOnboardingProbeState = .idle
    @State var remoteAuthIssue: RemoteGatewayAuthIssue?
    @State var suppressRemoteProbeReset = false
    @State var gatewayDiscovery: GatewayDiscoveryModel
    @State var onboardingSkillsModel = SkillsSettingsModel()
    @State var crestodianState = OnboardingCrestodianChatState()
    @State var aiSetup = OnboardingAISetupModel()
    @State var configuredGatewayProbe = OnboardingConfiguredGatewayProbe()
    @State var didLoadOnboardingSkills = false
    @State var localGatewayProbe: LocalGatewayProbe?
    @State var defaultsToLocalGateway: Bool
    @Bindable var state: AppState
    var permissionMonitor: PermissionMonitor
    let crestodianDefaults: UserDefaults

    static let windowWidth: CGFloat = 630
    static let windowHeight: CGFloat = 752 // ~+10% to fit full onboarding content

    let pageWidth: CGFloat = Self.windowWidth
    let connectionPageIndex = 1
    let cliPageIndex = 2
    let aiPageIndex = 3

    let permissionsPageIndex = 5

    var heroFrameHeight: CGFloat {
        145
    }

    var heroSize: CGFloat {
        130
    }

    /// Sized so the permissions page fits all capabilities without scrolling:
    /// heroFrameHeight + contentHeight + ~72 (nav bar) fills windowHeight 752.
    var contentHeight: CGFloat {
        Self.windowHeight - self.heroFrameHeight - 72
    }

    static func pageOrder(
        for mode: AppState.ConnectionMode,
        requiresCLIInstall: Bool) -> [Int]
    {
        switch mode {
        case .remote:
            // Remote setup doesn't need local gateway/CLI/workspace setup pages,
            // but the AI check runs against the remote gateway so a broken
            // remote model surfaces here, not in the first chat.
            return [0, 1, 3, 5, 9]
        case .unconfigured:
            return [0, 1, 9]
        case .local:
            let setupPages = requiresCLIInstall ? [0, 1, 2, 3, 5] : [0, 1, 3, 5]
            return setupPages + [9]
        }
    }

    var selectedConnectionMode: AppState.ConnectionMode {
        if self.isConnectionSelectionBlocking {
            return .local
        }
        return self.state.connectionMode
    }

    var isConnectionSelectionBlocking: Bool {
        self.defaultsToLocalGateway && self.state.connectionMode == .unconfigured
    }

    var pageOrder: [Int] {
        Self.pageOrder(
            for: self.state.connectionMode,
            requiresCLIInstall: self.state.connectionMode == .local && !self.cliInstalled)
    }

    var pageCount: Int {
        self.pageOrder.count
    }

    var activePageIndex: Int {
        self.activePageIndex(for: self.currentPage)
    }

    var buttonTitle: String {
        self.currentPage == self.pageCount - 1 ? "Finish" : "Next"
    }

    var isCLIBlocking: Bool {
        self.activePageIndex == self.cliPageIndex && !self.cliInstalled
    }

    /// Onboarding must not finish without working inference: the AI page
    /// blocks Next until a candidate passed its live test (config is authored
    /// server-side on that success). "Configure later" on the connection page
    /// remains the explicit skip path.
    var isAISetupBlocking: Bool {
        Self.shouldBlockAISetup(
            currentPage: self.currentPage,
            pageOrder: self.pageOrder,
            aiPageIndex: self.aiPageIndex,
            connectionMode: self.state.connectionMode,
            connected: self.aiSetup.connected)
    }

    static func shouldBlockAISetup(
        currentPage: Int,
        pageOrder: [Int],
        aiPageIndex: Int,
        connectionMode: AppState.ConnectionMode,
        connected: Bool) -> Bool
    {
        guard connectionMode != .unconfigured,
              !connected,
              let aiPageCursor = pageOrder.firstIndex(of: aiPageIndex)
        else {
            return false
        }
        return currentPage >= aiPageCursor
    }

    var canAdvance: Bool {
        !self.isCLIBlocking && !self.isAISetupBlocking
    }

    struct LocalGatewayProbe: Equatable {
        let port: Int
        let pid: Int32
        let command: String
        let expected: Bool
    }

    init(
        state: AppState = AppStateStore.shared,
        permissionMonitor: PermissionMonitor = .shared,
        discoveryModel: GatewayDiscoveryModel = GatewayDiscoveryModel(
            localDisplayName: InstanceIdentity.displayName,
            filterLocalGateways: false),
        aiSetupGateway: GatewayConnection = .shared,
        crestodianDefaults: UserDefaults = .standard,
        configuredGatewayProbeTimeoutMs: Double = 15000)
    {
        self.state = state
        self.permissionMonitor = permissionMonitor
        self.crestodianDefaults = crestodianDefaults
        _defaultsToLocalGateway = State(
            initialValue: !state.onboardingSeen && state.connectionMode == .unconfigured)
        _gatewayDiscovery = State(initialValue: discoveryModel)
        _aiSetup = State(initialValue: OnboardingAISetupModel(
            gateway: aiSetupGateway,
            defaults: crestodianDefaults,
            routeIdentityProvider: {
                OnboardingCrestodianResumeStore.selectedRouteIdentity(state: state)
            }))
        _configuredGatewayProbe = State(
            initialValue: OnboardingConfiguredGatewayProbe(
                gateway: aiSetupGateway,
                timeoutMs: configuredGatewayProbeTimeoutMs))
    }
}
