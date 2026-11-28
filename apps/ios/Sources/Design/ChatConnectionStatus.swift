import Network
import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// What the chat's status strip says about the connection. Nothing while connected: the strip never
/// says "Connected".
enum ChatConnectionStatus: Equatable {
    case unreachable
    case notConnected
    case reconnecting
    /// The Gateway turned the iPhone away; the app's own recovery for that problem is the action.
    case signIn(GatewayConnectionProblem)
    case pairing(GatewayConnectionProblem)
    case certificate(GatewayConnectionProblem)

    struct Input: Equatable {
        var state: GatewayDisplayState
        /// The connection problem the app retains, if any.
        var problem: GatewayConnectionProblem?
        /// An approval answer just failed because the connection was down.
        var approvalFailedUnreachable: Bool
        /// No Gateway was ever set up: the empty chat's first-connection card owns this.
        var isFirstSetup: Bool
        /// Talk is on: its row in the composer's place already says "Offline".
        var isTalkActive = false
    }

    static func resolve(_ input: Input) -> ChatConnectionStatus? {
        let status = self.resolveConnection(input)
        guard input.isTalkActive else { return status }
        // Talk's row says the waiting part; the strip keeps only a problem with a recovery.
        switch status {
        case .reconnecting, .unreachable: return nil
        default: return status
        }
    }

    private static func resolveConnection(_ input: Input) -> ChatConnectionStatus? {
        guard !input.isFirstSetup, input.state != .connected else { return nil }
        if input.state == .error, let problem = input.problem, let status = rejection(problem) {
            return status
        }
        if input.approvalFailedUnreachable { return .unreachable }
        switch input.state {
        case .connected:
            return nil
        case .error:
            // After a network failure the app keeps trying on its own (backing off, never giving up), so the
            // strip waits with it, without a button. Other problems (an old Gateway, rate limits, Tailscale)
            // keep the app's problem banner.
            return input.problem?.isUnreachable == true ? .reconnecting : nil
        case .connecting:
            return .reconnecting
        case .disconnected:
            return .notConnected
        }
    }

    /// Whether a chat in this state shows the problem in its strip, so the app's top banner leaves it out
    /// there. When the chat itself is connected the strip is empty and the banner keeps the problem.
    static func carries(_ problem: GatewayConnectionProblem, chatState: GatewayDisplayState) -> Bool {
        if problem.isUnreachable { return chatState != .connected }
        return chatState == .error && self.rejection(problem) != nil
    }

    private static func rejection(_ problem: GatewayConnectionProblem) -> ChatConnectionStatus? {
        if problem.needsCredentialUpdate { return .signIn(problem) }
        if problem.needsPairingApproval { return .pairing(problem) }
        switch problem.kind {
        case .tlsPinMismatch, .tlsCertificateUntrusted: return .certificate(problem)
        default: return nil
        }
    }

    static let stripID = "connection"

    /// The host as a person names it: a name loses an address's port ("studio.local:18789" reads
    /// "studio.local"), and a bare IP address, which names nothing, reads "OpenClaw".
    static func displayHost(_ name: String) -> String {
        let host = self.withoutPort(name.trimmingCharacters(in: .whitespacesAndNewlines))
        if IPv4Address(host) != nil || IPv6Address(host) != nil { return "OpenClaw" }
        return host
    }

    private static func withoutPort(_ name: String) -> String {
        if name.hasPrefix("["), let close = name.firstIndex(of: "]") {
            return String(name[name.index(after: name.startIndex)..<close])
        }
        guard let colon = name.lastIndex(of: ":"), name.firstIndex(of: ":") == colon,
              !name[name.index(after: colon)...].isEmpty,
              name[name.index(after: colon)...].allSatisfy(\.isNumber)
        else { return name }
        return String(name[..<colon])
    }

    /// `waitBeforeShowing` holds back a waiting state (not a failure), so the connect at launch and a quick
    /// reconnect never flash in the strip. `recovery` is the app's own action for a rejected connection.
    /// `isFirstConnect` says "Connecting" until the chat has connected once.
    @MainActor
    func strip(
        host: String,
        waitBeforeShowing: Duration,
        isFirstConnect: Bool = false,
        recovery: GatewayProblemRecovery?,
        retry: @escaping @MainActor @Sendable () async -> Void) -> OpenClawChatStatus
    {
        func status(
            _ priority: Int,
            _ format: String,
            tone: OpenClawChatStatus.Tone,
            action: OpenClawChatStatus.Action? = nil,
            delay: Duration = .zero) -> OpenClawChatStatus
        {
            OpenClawChatStatus(
                id: Self.stripID,
                priority: priority,
                text: String(format: format, host),
                truncatable: host,
                tone: tone,
                action: action,
                scope: .app,
                appearDelay: delay)
        }
        let tryAgain = OpenClawChatStatus.Action(title: String(localized: "Try again"), perform: retry)
        switch self {
        case .unreachable:
            // An approval answer failed while the app is still reconnecting: nothing to press, the card stays.
            return status(
                OpenClawChatStatusPriority.unreachable,
                String(localized: "Can’t reach %@"),
                tone: .info)
        case .notConnected:
            // The app stopped trying; this is where the retry belongs.
            return status(
                OpenClawChatStatusPriority.notConnected,
                String(localized: "Not connected to %@"),
                tone: .error,
                action: tryAgain,
                delay: waitBeforeShowing)
        case .reconnecting:
            return status(
                OpenClawChatStatusPriority.reconnecting,
                isFirstConnect ? String(localized: "Connecting to %@…") : String(localized: "Reconnecting to %@…"),
                tone: .progress,
                delay: waitBeforeShowing)
        case let .signIn(problem):
            return status(
                OpenClawChatStatusPriority.unreachable,
                String(localized: "Sign in to %@ again"),
                tone: .error,
                action: recovery?.action(for: problem, retry: tryAgain))
        case let .pairing(problem):
            return status(
                OpenClawChatStatusPriority.unreachable,
                UIDevice.current.userInterfaceIdiom == .pad
                    ? String(localized: "Approve this iPad on %@")
                    : String(localized: "Approve this iPhone on %@"),
                tone: .error,
                action: recovery?.action(for: problem, retry: tryAgain))
        case let .certificate(problem):
            return status(
                OpenClawChatStatusPriority.unreachable,
                problem.kind == .tlsPinMismatch
                    ? String(localized: "Verify %@ again")
                    : String(localized: "Can’t verify %@"),
                tone: .error,
                action: recovery?.action(for: problem, retry: tryAgain))
        }
    }
}

/// The app's own action for a connection problem: the one its top banner offers, owned by `RootTabs`.
/// The strip reuses it so a problem has one recovery wherever it shows.
struct GatewayProblemRecovery {
    let perform: @MainActor (GatewayConnectionProblem) -> Void

    /// The strip's short name for the banner's action. Resetting onboarding forgets every Gateway, so the
    /// strip never offers it; the banner keeps it.
    @MainActor
    func action(
        for problem: GatewayConnectionProblem,
        retry: OpenClawChatStatus.Action) -> OpenClawChatStatus.Action?
    {
        let title: String
        switch GatewayProblemPrimaryAction.route(for: problem) {
        case .retry: return retry
        case .resetOnboarding, .protocolMismatch: return nil
        case .trustCertificate: title = String(localized: "Trust")
        case .openSettings: title = String(localized: "Settings")
        }
        return OpenClawChatStatus.Action(title: title) { self.perform(problem) }
    }
}

extension EnvironmentValues {
    @Entry var gatewayProblemRecovery: GatewayProblemRecovery?
}

/// Feeds the connection into the chat's status strip. When the connection is back the strip just leaves:
/// the normal working state says nothing.
struct ChatConnectionStrip: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.gatewayProblemRecovery) private var recovery
    let strip: OpenClawChatStatusStrip
    let input: ChatConnectionStatus.Input
    /// Until the chat has connected once, the app is still making its first connection.
    @State private var hasConnected = false

    func body(content: Content) -> some View {
        content.onChange(of: self.input, initial: true) { _, input in
            if input.state == .connected { self.hasConnected = true }
            guard let status = ChatConnectionStatus.resolve(input) else {
                self.strip.clear(ChatConnectionStatus.stripID)
                return
            }
            // A second for a reconnect; the launch's own connect gets three before the strip says anything.
            let wait: Duration = self.hasConnected ? .seconds(1) : .seconds(3)
            self.strip.post(status.strip(
                host: self.hostName,
                waitBeforeShowing: wait,
                isFirstConnect: !self.hasConnected,
                recovery: self.recovery)
            { [gatewayController] in
                _ = await gatewayController.retryGatewayConnection()
            })
        }
    }

    /// The name the sidebar's connection control shows for this Gateway, without an address's port. Read
    /// only when the connection changes, not on every render.
    private var hostName: String {
        let presentation = SidebarGatewayPresentation(
            registry: self.appModel.loadDisplayedGatewayRegistry(),
            connectionID: self.appModel.activeGatewayConnectConfig?.effectiveStableID,
            connectedID: self.appModel.connectedGatewayID,
            state: self.input.state)
        let serverName = self.appModel.gatewayServerName
        let address = self.appModel.gatewayRemoteAddress
        let fallback = [serverName, address].contains { !($0?.trimmingCharacters(in: .whitespaces) ?? "").isEmpty }
            ? RootSidebar.gatewayName(serverName: serverName, remoteAddress: address)
            : "OpenClaw"
        return ChatConnectionStatus.displayHost(presentation.connectionName(fallback: fallback))
    }
}
